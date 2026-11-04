import {
	InstanceBase,
	InstanceStatus,
	type CompanionActionDefinitions,
	type CompanionFeedbackDefinitions,
	type CompanionOptionValues,
	type CompanionPresetDefinitions,
	type CompanionPresetSection,
	type CompanionStaticUpgradeScript,
	type CompanionVariableDefinitions,
	type CompanionVariableValues,
	type DropdownChoice,
	type CompanionInputFieldTextInput,
	type InstanceTypes,
	type JsonObject,
	type JsonValue,
	type SomeCompanionConfigField,
} from '@companion-module/base'
import { networkInterfaces } from 'node:os'
import { spawn } from 'node:child_process'
import { access, constants as fsConstants, stat } from 'node:fs/promises'
import { Engine, type InputInfo, type UserChange } from '../core/src/engine.js'
import { WebServer, BEACON_PORT } from '../core/src/web.js'
import { type Db, fmtDb, parseDb, parseNumber, positionToDb, clamp, MIN_DB } from '../core/src/law.js'
import { PAGE_DEFAULTS, type PageSettings } from '../core/src/settings.js'
import { AUTOLEVEL_STATES, type AutoLevelState } from '../core/src/autolevel.js'
import { DEFAULT_BAND, DEFAULT_DWELL_MS, DEFAULT_FLASH_MS, DEFAULT_RELEASE_BAND, DEFAULT_RELEASE_MS, NEVER_RELEASE_BAND } from '../core/src/pickup.js'
import { parseColour, rgb, scaleColour } from '../core/src/colour.js'
import { ALL_PARAMS, BAND_COUNT, BAND_KIND, COMPRESSOR_KIND, EQ_KIND, EXPANDER_KIND, LIMITER_KIND, kindOf } from './atem-processing.js'
import { ATEM_INFO, ATEM_PORT, AtemDevice, atemEngineOptions } from './atem-device.js'
import type { AtemLink } from './atem-link.js'
import { RealAtemLink } from './atem-link-real.js'
import { upgradeScripts } from './upgrades.js'

/**
 * The connection's saved config. Configs saved by older versions may be missing some of these,
 * so every read allows for that.
 */
export interface Config extends JsonObject {
	host: string
	port: string | number
	webPort: string | number
	webBind: string
	pin: string
	finderOn: boolean
	finderPort: string | number
	varRateHz: string | number
	updateHours: string | number
	recFolder: string
	gridBand: string | number
	gridDwellMs: string | number
	gridReleaseBand: string | number
	gridReleaseMs: string | number
	/** The module's own settings, saved here by the module (not edited by hand) */
	store: string
	autosave: string
	/** Hand-typed values put aside while a field is set by the 'Connection: set settings' action (JSON, field → value) */
	actionSaved: string
}

interface AtemAudioTypes extends InstanceTypes {
	config: Config
	secrets: undefined
}

interface Resolved {
	host: string
	port: number
	webPort: number
	bind: string
	pin: string
	finderPort: number
	varRateHz: number
	updateHours: number
	recFolder: string
	grid: { band: number; dwellMs: number; releaseBand: number; releaseMs: number }
}

/** The connection fields that hold settings (and can be handed over to the 'Connection: set settings' action) */
export const CONN_FIELDS = ['host', 'port', 'webPort', 'webBind', 'pin', 'finderPort', 'varRateHz', 'updateHours', 'recFolder', 'gridBand', 'gridDwellMs', 'gridReleaseBand', 'gridReleaseMs'] as const
type ConnField = (typeof CONN_FIELDS)[number]

const CONN_LABELS: Record<ConnField, string> = {
	host: 'ATEM address',
	port: `ATEM port (default ${ATEM_PORT})`,
	webPort: 'Fader page port (default 8891, 0 = off)',
	webBind: 'Fader page available on',
	pin: 'Fader page PIN (blank = none)',
	finderPort: `Page finder port (UDP, default ${BEACON_PORT}, 0 = off)`,
	varRateHz: 'Meter variables: updates per second (default 5)',
	updateHours: 'Check for module updates every (hours, default 12, 0 = never)',
	recFolder: 'Where the recordings can be found (blank = nowhere)',
	gridBand: `Catch band (± fader steps of 127, default ${DEFAULT_BAND})`,
	gridDwellMs: `Dwell time (ms, default ${DEFAULT_DWELL_MS})`,
	gridReleaseBand: `Release band (± fader steps, default ${DEFAULT_RELEASE_BAND}, ${NEVER_RELEASE_BAND} = never)`,
	gridReleaseMs: `Release time (ms, default ${DEFAULT_RELEASE_MS})`,
}

const BY_ACTION_TIP =
	"Hands this field over to the 'Connection: set settings' action, so a button or a trigger can change it (from a variable, say). " +
	"While it's ticked the field's locked here and shows what the action last set. Untick it and you get back what you'd typed before."

/** The connection fields that hold a number */
const NUMBER_FIELDS = new Set<ConnField>(['port', 'webPort', 'finderPort', 'varRateHz', 'updateHours', 'gridBand', 'gridDwellMs', 'gridReleaseBand', 'gridReleaseMs'])

/** Allowed whole-number range for each number field (the same limits used when the connection is applied) */
export const NUMBER_RANGES: Record<string, [number, number]> = {
	port: [1, 65535],
	webPort: [0, 65535],
	finderPort: [0, 65535],
	varRateHz: [1, 20],
	updateHours: [0, 720],
	gridBand: [0, 64],
	gridDwellMs: [0, 10000],
	gridReleaseBand: [0, NEVER_RELEASE_BAND],
	gridReleaseMs: [0, 60000],
}

/** Whether a connection field is ticked "Can be set by the action" */
function isTicked(config: Config | undefined, f: ConnField): boolean {
	return config?.[`${f}_byAction`] === true
}

const PAGE_SETTING_CHOICES = (Object.keys(PAGE_DEFAULTS) as (keyof PageSettings)[]).map((k) => ({ id: k, label: k }))

/** Open a web address in this computer's default browser */
function openInBrowser(url: string, warn: (m: string) => void): void {
	try {
		const [cmd, args] = process.platform === 'win32' ? ['cmd', ['/c', 'start', '""', url]] : process.platform === 'darwin' ? ['open', [url]] : ['xdg-open', [url]]
		const child = spawn(cmd, args as string[], { detached: true, stdio: 'ignore', windowsHide: true })
		child.on('error', (e) => warn(`Couldn't open a browser: ${e.message}`))
		child.unref()
	} catch (e) {
		warn(`Couldn't open a browser: ${(e as Error).message}`)
	}
}

/** The page's network setting: 'all', 'local', or an address */
function bindAddress(v: string): string {
	const t = v.trim().toLowerCase()
	if (t === '' || t === 'all' || t === '0.0.0.0') return '0.0.0.0'
	if (t === 'local' || t === 'localhost') return '127.0.0.1'
	return v.trim()
}

/** This computer's IPv4 network addresses */
function localAddresses(): { name: string; address: string }[] {
	const out: { name: string; address: string }[] = []
	for (const [name, list] of Object.entries(networkInterfaces())) {
		for (const a of list ?? []) if (a.family === 'IPv4' && !a.internal) out.push({ name, address: a.address })
	}
	return out
}

/**
 * Can this computer read the recordings folder? '' if so, otherwise why not, in plain words.
 * FTP addresses are kept, but not read (yet): the file manager says so.
 */
export async function folderProblem(dir: string): Promise<string> {
	const d = dir.trim()
	if (!d) return "No recordings folder set, so I can't see the ATEM's recordings from here."
	if (/^ftps?:\/\//i.test(d))
		return (
			"I can't read the ATEM's FTP server myself yet. Connect to it as a drive on this computer " +
			'(Finder: Go → Connect to Server; Windows: Map network drive) and put that folder here instead.'
		)
	try {
		const s = await stat(d)
		if (!s.isDirectory()) return `"${d}" is a file, not a folder.`
		await access(d, fsConstants.R_OK)
		return ''
	} catch (e) {
		const code = (e as NodeJS.ErrnoException).code
		if (code === 'ENOENT') return `I can't find the folder "${d}" on this computer. Is the drive plugged in, or the share connected?`
		if (code === 'EACCES' || code === 'EPERM') return `I'm not allowed to read "${d}". Check its sharing / permissions.`
		return `I can't read "${d}": ${(e as Error).message}`
	}
}

/** The recordings folder as the device should report it: local paths only (an FTP address can't be listed from here) */
export function deviceFolder(dir: string): string {
	const d = dir.trim()
	return /^[a-z][a-z0-9+.-]*:\/\//i.test(d) ? '' : d
}

const INPUT_TIP = 'The input as the ATEM calls it, its number in the list (1 = first), or its id (in1, in1301.2, master, monitor, talkback). Can be a variable.'

const inputOption: CompanionInputFieldTextInput = {
	type: 'textinput',
	label: 'Input (name, number or id)',
	id: 'input',
	default: '1',
	useVariables: true,
	tooltip: INPUT_TIP,
}

const BLACK = rgb(0, 0, 0)

const STATUS_COLOURS: Record<AutoLevelState, string> = {
	off: '',
	holding: '#3b2466',
	riding: '#0077aa',
	frozen: '#555555',
	limit: '#b36b00',
	capturing: '#8b5cf6',
	calibrating: '#8b5cf6',
}

/** Fixed processing blocks on a Fairlight input, by our block id */
const BLOCK_CHOICES: DropdownChoice[] = [
	{ id: 'eq', label: 'EQ' },
	...Array.from({ length: BAND_COUNT }, (_, i) => ({ id: `band${i + 1}`, label: `EQ band ${i + 1}` })),
	{ id: 'expander', label: 'Expander / gate' },
	{ id: 'compressor', label: 'Compressor' },
	{ id: 'limiter', label: 'Limiter' },
]
const BLOCK_OF_KIND: Record<string, string> = { [EQ_KIND]: 'eq', [EXPANDER_KIND]: 'expander', [COMPRESSOR_KIND]: 'compressor', [LIMITER_KIND]: 'limiter' }

const MIX_CHOICES: DropdownChoice[] = [
	{ id: 'on', label: 'On' },
	{ id: 'off', label: 'Off' },
	{ id: 'afv', label: 'Audio follow video' },
	{ id: 'toggle_on', label: 'Toggle on / off' },
	{ id: 'toggle_afv', label: 'Toggle AFV / off' },
	{ id: 'ftb', label: 'Master: follow fade to black' },
	{ id: 'free', label: 'Master: ignore fade to black' },
]

const BUS_CHOICES: DropdownChoice[] = [
	{ id: 'monitor', label: 'Headphones / monitor' },
	{ id: 'phones', label: 'Headphones (classic)' },
	{ id: 'phones_prog', label: 'Headphones: programme' },
	{ id: 'talkback', label: 'Talkback' },
	{ id: 'sidetone', label: 'Sidetone' },
]

export const UpgradeScripts: CompanionStaticUpgradeScript<Config>[] = upgradeScripts<Config>()

export default class AtemAudioInstance extends InstanceBase<AtemAudioTypes> {
	config!: Config
	engine!: Engine
	web: WebServer | null = null
	/** Makes the ATEM link; tests swap in a pretend ATEM */
	makeLink: () => AtemLink = () => new RealAtemLink()
	#varTimer: NodeJS.Timeout | null = null
	#lastSaved = ''
	#structureTimer: NodeJS.Timeout | null = null
	#resolved: Resolved | null = null
	#recordingActions = false
	#varWarned = new Set<string>()
	#folderProblem = ''
	#folderChecked = ''
	#folderTimer: NodeJS.Timeout | null = null
	/** Values for {var:name} in recording names, set by 'Recordings: set a value for the name' */
	#nameVars: Record<string, string> = {}

	override async init(config: Config): Promise<void> {
		this.config = config
		this.engine = new Engine(
			{
				log: (level, msg) => this.log(level, msg),
				save: (store, autosave) => this.#saveStore(store, autosave),
				structureChanged: () => this.#structureChanged(),
				stateChanged: () => this.#stateChanged(),
			},
			ATEM_INFO,
			atemEngineOptions(),
			config.store,
			config.autosave ?? '',
		)
		this.#lastSaved = config.store ?? ''
		this.engine.on('status', () => this.#status())
		this.engine.on('userChange', (c: UserChange) => {
			if (!this.#recordingActions) return
			const r = recordedAction(c)
			if (r) this.recordAction({ actionId: r.actionId, options: r.options }, r.key)
		})
		this.updateStatus(InstanceStatus.Connecting)
		await this.#apply()
		this.#structureChanged()
	}

	get device(): AtemDevice | undefined {
		return this.engine?.device instanceof AtemDevice ? this.engine.device : undefined
	}

	/**
	 * A connection field's value, trimmed. Connection fields can't take variables, so one that
	 * has "$(" in it is treated as blank (its default), with a warning in the log.
	 */
	#field(id: ConnField): string {
		const v = String(this.config[id] ?? '').trim()
		if (!v.includes('$(')) return v
		const key = `${id}=${v}`
		if (!this.#varWarned.has(key)) {
			this.#varWarned.add(key)
			this.log(
				'warn',
				`"${CONN_LABELS[id]}" on the connection page has a variable in it (${v}). Connection fields can't take variables, so I'm using the default for now. ` +
					`Want a variable to drive it? Tick "Can be set by the action" next to it, then use the "Connection: set settings" action (a trigger on "variable changed" does the job nicely).`,
			)
		}
		return ''
	}

	/** Work out the connection settings and apply any that changed */
	async #apply(): Promise<void> {
		const f = (id: ConnField) => this.#field(id)
		const r: Resolved = {
			host: f('host'),
			port: parseNumber(f('port'), ATEM_PORT, 1, 65535),
			webPort: parseNumber(f('webPort'), 8891, 0, 65535),
			bind: bindAddress(f('webBind')),
			pin: f('pin'),
			finderPort: this.config.finderOn === false ? 0 : parseNumber(f('finderPort'), BEACON_PORT, 0, 65535),
			varRateHz: parseNumber(f('varRateHz'), 5, 1, 20),
			updateHours: parseNumber(f('updateHours'), 12, 0, 720),
			recFolder: f('recFolder'),
			grid: {
				band: parseNumber(f('gridBand'), DEFAULT_BAND, 0, 64),
				dwellMs: parseNumber(f('gridDwellMs'), DEFAULT_DWELL_MS, 0, 10000),
				releaseBand: parseNumber(f('gridReleaseBand'), DEFAULT_RELEASE_BAND, 0, NEVER_RELEASE_BAND),
				releaseMs: parseNumber(f('gridReleaseMs'), DEFAULT_RELEASE_MS, 0, 60000),
			},
		}
		const old = this.#resolved
		this.#resolved = r
		if (!old || old.recFolder !== r.recFolder) await this.#checkFolder(r.recFolder)
		if (!old || old.host !== r.host || old.port !== r.port) {
			this.updateStatus(InstanceStatus.Connecting)
			this.engine.useDevice(new AtemDevice({ host: r.host, port: Math.round(r.port), makeLink: this.makeLink, recordingsFolder: deviceFolder(r.recFolder) }))
		} else if (old.recFolder !== r.recFolder && this.device) {
			this.device.opts.recordingsFolder = deviceFolder(r.recFolder)
			void this.engine.recorder.refresh()
		}
		this.engine.sourceName = this.label
		if (!old || old.webPort !== r.webPort || old.bind !== r.bind || old.pin !== r.pin || old.finderPort !== r.finderPort) {
			this.web?.stop()
			this.web = null
			if (r.webPort > 0) {
				this.web = new WebServer(
					this.engine,
					{ port: Math.round(r.webPort), bind: r.bind, pin: r.pin, beacon: r.finderPort > 0 ? { port: Math.round(r.finderPort) } : undefined, name: () => this.label },
					(level, msg) => this.log(level, msg),
				)
				this.web.start()
			}
			this.setVariableValues(this.#urlVariables())
		}
		if (!old || old.varRateHz !== r.varRateHz) this.#restartVarTimer()
		if (!old || old.updateHours !== r.updateHours) this.engine.setUpdateChecks(r.updateHours)
		if (!old || JSON.stringify(old.grid) !== JSON.stringify(r.grid)) this.setVariableValues(this.#urlVariables())
	}

	/**
	 * Check the recordings folder can be read; say why not (once per folder, and again
	 * when that changes). Checked every 15 s, so a drive plugged in later is picked up.
	 */
	async #checkFolder(dir: string): Promise<void> {
		const was = this.#folderProblem
		this.#folderProblem = dir.trim() ? await folderProblem(dir) : ''
		if (this.#folderProblem && (this.#folderChecked !== dir || was !== this.#folderProblem)) this.log('warn', `Recordings folder: ${this.#folderProblem}`)
		else if (!this.#folderProblem && was && this.#folderChecked === dir) {
			this.log('info', `Recordings folder: I can see "${dir}" now`)
			void this.engine.recorder.refresh()
		}
		this.#folderChecked = dir
		this.setVariableValues({ rec_folder_problem: this.#folderProblem })
		if (!this.#folderTimer) this.#folderTimer = setInterval(() => void this.#checkFolder(this.#resolved?.recFolder ?? ''), 15000)
	}

	#status(): void {
		if (this.engine.connected) {
			if (this.device?.mixer === 'none') this.updateStatus(InstanceStatus.UnknownWarning, "Connected, but this ATEM hasn't got an audio mixer I can drive")
			else this.updateStatus(InstanceStatus.Ok)
		} else this.updateStatus(this.#resolved?.host ? InstanceStatus.ConnectionFailure : InstanceStatus.BadConfig, this.engine.deviceError || 'Waiting for the ATEM')
	}

	#restartVarTimer(): void {
		if (this.#varTimer) clearInterval(this.#varTimer)
		const hz = clamp(this.#resolved?.varRateHz ?? 5, 1, 20)
		this.#varTimer = setInterval(() => this.#meterVariables(), 1000 / hz)
	}

	override async destroy(): Promise<void> {
		if (this.#varTimer) clearInterval(this.#varTimer)
		if (this.#structureTimer) clearTimeout(this.#structureTimer)
		if (this.#folderTimer) clearInterval(this.#folderTimer)
		this.web?.stop()
		this.engine.destroy()
	}

	override async configUpdated(config: Config): Promise<void> {
		const old = this.config
		// the store and the saved hand-typed values are the module's own: keep the running copies
		const next: Config = { ...config, store: old.store, autosave: old.autosave, actionSaved: old.actionSaved }
		const n = next as Record<string, JsonValue | undefined>
		const o = old as Record<string, JsonValue | undefined>
		const saved = this.#savedValues()
		let ticksChanged = false
		for (const f of CONN_FIELDS) {
			const was = isTicked(old, f)
			const now = isTicked(next, f)
			if (!was && now) {
				// handed over to the action: remember what was typed, to put back when it's unticked
				saved[f] = String(n[f] ?? '')
				ticksChanged = true
			} else if (was && now) {
				// locked: only the action changes it, so a stale value from the connection page doesn't win
				n[f] = o[f]
			} else if (was && !now) {
				if (f in saved) n[f] = saved[f]
				delete saved[f]
				ticksChanged = true
			}
		}
		if (Object.keys(saved).length || old.actionSaved) next.actionSaved = JSON.stringify(saved)
		this.config = next
		if (ticksChanged) this.setActionDefinitions(this.#actions())
		await this.#apply()
		const keys = new Set([...Object.keys(config), ...Object.keys(next)])
		if ([...keys].some((k) => JSON.stringify(config[k]) !== JSON.stringify(next[k]))) this.saveConfig(this.config)
	}

	/** The hand-typed values put aside while a field is set by the action (field id → value) */
	#savedValues(): Partial<Record<ConnField, string>> {
		try {
			const v: unknown = JSON.parse(String(this.config.actionSaved ?? '') || '{}')
			if (!v || typeof v !== 'object' || Array.isArray(v)) return {}
			const out: Partial<Record<ConnField, string>> = {}
			for (const f of CONN_FIELDS) {
				const x = (v as Record<string, unknown>)[f]
				if (x !== undefined) out[f] = String(x)
			}
			return out
		} catch {
			return {}
		}
	}

	/** A field's current value for the connection page, with the PIN kept to itself */
	#shownValue(f: ConnField): string {
		const v = String(this.config?.[f] ?? '').trim()
		if (f === 'pin') return v ? '•••••• (hidden)' : 'blank (none)'
		if (f === 'webBind' && (v === '' || v === 'all')) return 'all network connections'
		if (f === 'webBind' && v === 'local') return 'this computer only'
		return v || 'blank (so the default)'
	}

	#tickedFields(): ConnField[] {
		return CONN_FIELDS.filter((f) => isTicked(this.config, f))
	}

	/** Run 'Connection: set settings': write the given values into the ticked fields, then apply them */
	async #setByAction(options: CompanionOptionValues): Promise<void> {
		const ticked = this.#tickedFields()
		if (!ticked.length) {
			this.log('info', "Connection: set settings: nothing's ticked \"Can be set by the action\" on the connection page yet, so there's nothing for me to set.")
			return
		}
		const next = { ...this.config } as Record<string, JsonValue | undefined>
		let changed = false
		for (const f of CONN_FIELDS) {
			const v = this.#text(options, f)
			if (v === '') continue
			if (!ticked.includes(f)) {
				this.log('info', `Connection: set settings: "${CONN_LABELS[f]}" isn't ticked "Can be set by the action" on the connection page, so I've left it alone.`)
				continue
			}
			if (NUMBER_FIELDS.has(f)) {
				const n = Number(v)
				const [lo, hi] = NUMBER_RANGES[f]
				if (!Number.isInteger(n) || n < lo || n > hi) {
					this.log('warn', `Connection: set settings: "${CONN_LABELS[f]}" needs a whole number from ${lo} to ${hi}, and "${v}" isn't one. Left it as it was.`)
					continue
				}
			}
			if (f === 'host' && /\s/.test(v)) {
				this.log('warn', `Connection: set settings: "${v}" can't be an ATEM address (it has a space in it). Left it as it was.`)
				continue
			}
			if (String(next[f] ?? '') !== v) {
				next[f] = v
				changed = true
			}
		}
		if (!changed) return
		this.config = next as Config
		this.saveConfig(this.config)
		await this.#apply()
	}

	override handleStartStopRecordActions(isRecording: boolean): void {
		this.#recordingActions = isRecording
	}

	#saveStore(store: string, autosave: string): void {
		if (store === this.#lastSaved && autosave === this.config.autosave) return
		this.#lastSaved = store
		this.config = { ...this.config, store, autosave }
		this.saveConfig(this.config)
	}

	/** The fader page's addresses on this computer */
	#pageUrls(): string[] {
		const r = this.#resolved
		if (!r || r.webPort <= 0) return []
		const port = Math.round(r.webPort)
		if (r.bind === '127.0.0.1') return [`http://127.0.0.1:${port}/`]
		if (r.bind !== '0.0.0.0') return [`http://${r.bind}:${port}/`]
		return [...localAddresses().map((a) => `http://${a.address}:${port}/`), `http://127.0.0.1:${port}/`]
	}

	#urlVariables(): CompanionVariableValues {
		const urls = this.#pageUrls()
		const g = this.#resolved?.grid
		return {
			page_url: urls[0] ?? '',
			page_urls: urls.join(' '),
			grid_catch_band: g?.band ?? DEFAULT_BAND,
			grid_dwell_ms: g?.dwellMs ?? DEFAULT_DWELL_MS,
			grid_release_band: g?.releaseBand ?? DEFAULT_RELEASE_BAND,
			grid_release_ms: g?.releaseMs ?? DEFAULT_RELEASE_MS,
		}
	}

	override getConfigFields(): SomeCompanionConfigField[] {
		const urls = this.#pageUrls()
		const x = this.device?.extras()
		const atemState = this.engine?.connected
			? `Connected to ${x?.model || 'the ATEM'} (${x?.mixer === 'fairlight' ? 'Fairlight audio' : x?.mixer === 'classic' ? 'classic audio mixer' : 'no audio mixer'}). All good.`
			: `Not connected to the ATEM. ${this.engine?.deviceError || ''}`
		const nets = localAddresses()
		/** A connection field, plus its "Can be set by the action" tick and what it shows while ticked */
		const lock = (field: SomeCompanionConfigField & { id: ConnField }): SomeCompanionConfigField[] => [
			{ ...field, isVisibleExpression: `!$(options:${field.id}_byAction)` },
			{
				type: 'static-text',
				id: `${field.id}_locked`,
				label: field.label,
				width: field.width,
				value: `Set by the 'Connection: set settings' action: ${this.#shownValue(field.id)}`,
				isVisibleExpression: `$(options:${field.id}_byAction)`,
			},
			{
				type: 'checkbox',
				id: `${field.id}_byAction`,
				label: 'Can be set by the action',
				width: 3,
				default: false,
				disableAutoExpression: true,
				tooltip: BY_ACTION_TIP,
			},
		]
		return [
			{
				type: 'static-text',
				id: 'info',
				label: 'Status',
				width: 12,
				value:
					`${atemState}<br>` +
					(urls.length ? `Fader page: ${urls.map((u) => `<a href="${u}" target="_blank">${u}</a>`).join(' · ')}` : 'Fader page: off for now.') +
					"<br>Setting up: just the ATEM's IP address. Find it in ATEM Setup (Configure → Network), or on the front panel of the bigger ones. The ATEM and this computer need to be on the same network." +
					"<br>Heads up: an ATEM only takes a handful of control connections at once (nobody's said exactly how many: roughly 5 on small or older models, 8 on the big ones). This connection, ATEM Software Control and the official ATEM module each use one." +
					'<br>Want a button, a trigger or a variable to change one of these settings? Tick <b>Can be set by the action</b> next to it, then use the <b>Connection: set settings</b> action.',
			},
			...lock({
				type: 'textinput',
				id: 'host',
				label: CONN_LABELS.host,
				width: 9,
				default: '',
				tooltip: "The ATEM's IP address, e.g. 192.168.10.240. ATEM Setup shows it under Configure → Network.",
			}),
			...lock({
				type: 'textinput',
				id: 'port',
				label: CONN_LABELS.port,
				width: 9,
				default: String(ATEM_PORT),
				tooltip: `The ATEM's control port. It's ${ATEM_PORT} on every ATEM: only change it if you're going through something that moves it.`,
			}),
			...lock({
				type: 'textinput',
				id: 'webPort',
				label: CONN_LABELS.webPort,
				width: 9,
				default: '8891',
				tooltip: 'The port the fader and meter page lives on. Open http://<this computer>:<port>/ in any browser on the network. 0 switches the page off. (OBS Audio uses 8890, so they can sit side by side.)',
			}),
			...lock({
				type: 'dropdown',
				id: 'webBind',
				label: CONN_LABELS.webBind,
				width: 9,
				default: 'all',
				allowCustom: true,
				tooltip:
					"Which of this computer's network connections the page answers on, like Companion's own \"network interface\" setting. All = any of them. This computer only = just a browser on this computer. Or pick one connection. It doesn't decide who's allowed in, mind: that's what the PIN is for. You can also type an address.",
				choices: [
					{ id: 'all', label: 'All network connections' },
					{ id: 'local', label: 'This computer only (127.0.0.1)' },
					...nets.map((n) => ({ id: n.address, label: `${n.name}: ${n.address}` })),
				],
			}),
			...lock({
				type: 'textinput',
				id: 'pin',
				label: CONN_LABELS.pin,
				width: 9,
				default: '',
				tooltip: 'Set one and the page asks for it before showing anything or letting anyone change things. Pages joining this one ask for it once, then remember it.',
			}),
			{
				type: 'checkbox',
				id: 'finderOn',
				label: 'Let other pages find this one',
				width: 9,
				default: true,
				tooltip:
					"Says hello on the network every few seconds so other ATEM Audio and OBS Audio pages can find this one and pull its strips in (and listens for theirs). Off: nothing's announced, but pages can still join by typing this page's address. The PIN still applies either way.",
			},
			...lock({
				type: 'textinput',
				id: 'finderPort',
				label: CONN_LABELS.finderPort,
				width: 9,
				default: String(BEACON_PORT),
				tooltip: `The UDP port pages say hello on. Every ATEM Audio and OBS Audio connection that should find each other needs the same one (${BEACON_PORT} unless you've a reason). Several connections on one computer can share it.`,
			}),
			...lock({
				type: 'textinput',
				id: 'varRateHz',
				label: CONN_LABELS.varRateHz,
				width: 9,
				default: '5',
				tooltip: 'How often the meter level variables update (1 to 20). Higher looks smoother on buttons, but keeps everything busier.',
			}),
			...lock({
				type: 'textinput',
				id: 'updateHours',
				label: CONN_LABELS.updateHours,
				width: 9,
				default: '12',
				tooltip: "How often I peek at GitHub for a newer ATEM Audio module. Needs internet. 0 = never. (ATEM software updates aren't checked: Blackmagic doesn't publish them anywhere I can ask.)",
			}),
			...lock({
				type: 'textinput',
				id: 'recFolder',
				label: CONN_LABELS.recFolder,
				width: 9,
				default: '',
				tooltip:
					"The ATEM records to a USB or SSD drive plugged into it, so I can only show those files if this computer can see them: a folder here, or a shared drive. " +
					"ATEM Mini Pro, Pro ISO and Extreme have an FTP server for the drive: connect to it as a drive on this computer and put that folder here. Blank = don't look.",
			}),
			{
				type: 'static-text',
				id: 'gridInfo',
				label: 'Grid fader pickup (this connection)',
				width: 12,
				value: "These are what 'Fader: from a value (Intech Grid fader), with pickup' uses whenever its own pickup fields are left blank. Each ATEM Audio connection gets its own set.",
			},
			...lock({
				type: 'textinput',
				id: 'gridBand',
				label: CONN_LABELS.gridBand,
				width: 9,
				default: String(DEFAULT_BAND),
				tooltip: "How close the Grid fader has to get to the ATEM's level before it takes over.",
			}),
			...lock({
				type: 'textinput',
				id: 'gridDwellMs',
				label: CONN_LABELS.gridDwellMs,
				width: 9,
				default: String(DEFAULT_DWELL_MS),
				tooltip: 'How long the Grid fader has to sit inside the catch band before it takes over. Stops a quick swipe past grabbing it.',
			}),
			...lock({
				type: 'textinput',
				id: 'gridReleaseBand',
				label: CONN_LABELS.gridReleaseBand,
				width: 9,
				default: String(DEFAULT_RELEASE_BAND),
				tooltip: 'Once latched, only a move on the ATEM side bigger than this makes the Grid fader let go.',
			}),
			...lock({
				type: 'textinput',
				id: 'gridReleaseMs',
				label: CONN_LABELS.gridReleaseMs,
				width: 9,
				default: String(DEFAULT_RELEASE_MS),
				tooltip: 'How long a move on the ATEM side has to stay outside the release band before the Grid fader lets go.',
			}),
			{
				type: 'static-text',
				id: 'bundle',
				label: "Psst. This one's got mates. 🍹",
				width: 12,
				value:
					'ATEM Audio is part of a little crew of Companion modules: some brand new, some old favourites given a good tweak. ' +
					"Want to know who else is in the crew, or grab the freshest version of each one? It's all here: " +
					'<a href="https://github.com/nisted/companion-modules" target="_blank">github.com/nisted/companion-modules</a>',
			},
		]
	}

	// ---- helpers ----------------------------------------------------------------

	/** An option's value as text. Companion has already filled in any variables or expression. */
	#text(options: CompanionOptionValues, id: string): string {
		const v = options[id]
		return (v === null || v === undefined ? '' : typeof v === 'object' ? JSON.stringify(v) : String(v)).trim()
	}

	#input(options: CompanionOptionValues, id = 'input'): InputInfo | undefined {
		const t = this.#text(options, id)
		const inp = this.engine.resolve(t)
		if (!inp) this.log('warn', `The ATEM hasn't got an audio input "${t}"`)
		return inp
	}

	/** Run a device call that the core doesn't wrap; log (not throw) if it fails */
	async #dev(what: string, fn: (d: AtemDevice) => Promise<unknown>): Promise<void> {
		const d = this.device
		if (!d?.connected) return this.log('warn', `${what}: not connected to the ATEM`)
		try {
			await fn(d)
		} catch (e) {
			this.log('warn', `${what}: ${(e as Error).message}`)
		}
	}

	#structureChanged(): void {
		if (this.#structureTimer) return
		this.#structureTimer = setTimeout(() => {
			this.#structureTimer = null
			this.#definitions()
			this.#stateChanged()
		}, 100)
	}

	#definitions(): void {
		this.setActionDefinitions(this.#actions())
		this.setFeedbackDefinitions(this.#feedbacks())
		this.setVariableDefinitions(this.#variableDefs())
		const { structure, presets } = this.#presets()
		this.setPresetDefinitions(structure, presets)
	}

	#stateChanged(): void {
		this.checkAllFeedbacks()
		this.setVariableValues(this.#stateVariables())
	}

	// ---- variables ----------------------------------------------------------------

	#variableDefs(): CompanionVariableDefinitions {
		const defs: { variableId: string; name: string }[] = [
			{ variableId: 'connected', name: 'Connected to the ATEM' },
			{ variableId: 'inputs', name: 'Number of inputs shown' },
			{ variableId: 'module_version', name: 'ATEM Audio module: this version' },
			{ variableId: 'module_latest', name: 'ATEM Audio module: latest version' },
			{ variableId: 'module_update', name: 'ATEM Audio module: update available' },
			{ variableId: 'atem_model', name: 'ATEM: model' },
			{ variableId: 'atem_mixer', name: 'ATEM: audio mixer (fairlight / classic / none)' },
			{ variableId: 'atem_protocol', name: 'ATEM: protocol version' },
			{ variableId: 'atem_error', name: 'Why the ATEM is not connected (blank when connected)' },
			{ variableId: 'afv_crossfade', name: 'ATEM: audio follow video crossfades on transitions' },
			{ variableId: 'auto_level_count', name: 'Auto level: how many inputs have it on' },
			{ variableId: 'page_url', name: 'Fader page address' },
			{ variableId: 'page_urls', name: 'Fader page addresses (all network connections)' },
			{ variableId: 'grid_catch_band', name: 'Grid fader pickup: catch band (this connection)' },
			{ variableId: 'grid_dwell_ms', name: 'Grid fader pickup: dwell time ms (this connection)' },
			{ variableId: 'grid_release_band', name: 'Grid fader pickup: release band (this connection)' },
			{ variableId: 'grid_release_ms', name: 'Grid fader pickup: release time ms (this connection)' },
			{ variableId: 'rec_state', name: 'Recording: recording / stopped' },
			{ variableId: 'rec_time', name: 'Recording: time so far' },
			{ variableId: 'rec_next', name: 'Recording: next planned start (HH:MM)' },
			{ variableId: 'rec_countdown', name: 'Recording: countdown to the next start' },
			{ variableId: 'rec_auto', name: 'Recording: next start is automatic' },
			{ variableId: 'rec_file_name', name: 'Recording: file name on the ATEM' },
			{ variableId: 'rec_disk', name: 'Recording: disk in use' },
			{ variableId: 'rec_remaining', name: 'Recording: time left on the disk (HH:MM:SS)' },
			{ variableId: 'rec_remaining_s', name: 'Recording: time left on the disk (seconds)' },
			{ variableId: 'rec_error', name: 'Recording: problem the ATEM reports (blank = none)' },
			{ variableId: 'rec_iso', name: 'Recording: ISO (every input) on' },
			{ variableId: 'rec_folder', name: 'Recording: folder this computer reads them from' },
			{ variableId: 'rec_folder_problem', name: "Recording: why the folder can't be read (blank = fine)" },
			{ variableId: 'rec_files', name: 'Recording: files in the folder' },
			{ variableId: 'stream_state', name: 'Streaming: idle / connecting / streaming / stopping' },
			{ variableId: 'stream_time', name: 'Streaming: time so far' },
			{ variableId: 'stream_bitrate', name: 'Streaming: encoding bitrate (bits per second)' },
			{ variableId: 'solo', name: 'Input being soloed' },
			{ variableId: 'notices', name: 'Pop-ups waiting' },
			{ variableId: 'notice', name: 'Latest pop-up' },
			...this.engine.recordings.variableDefinitions(),
		]
		this.engine.visible().forEach((inp, idx) => {
			const n = idx + 1
			const p = `in${n}_`
			const lab = `Input ${n} (${inp.name})`
			defs.push(
				{ variableId: `${p}name`, name: `${lab}: name` },
				{ variableId: `${p}id`, name: `${lab}: id` },
				{ variableId: `${p}vol`, name: `${lab}: fader dB` },
				{ variableId: `${p}trim`, name: `${lab}: trim dB` },
				{ variableId: `${p}mute`, name: `${lab}: muted (off)` },
				{ variableId: `${p}mix`, name: `${lab}: on / off / afv (master: ftb / free)` },
				{ variableId: `${p}bal`, name: `${lab}: balance (-100 L to 100 R)` },
				{ variableId: `${p}delay`, name: `${lab}: delay in frames` },
				{ variableId: `${p}auto_level`, name: `${lab}: auto level status` },
				{ variableId: `${p}auto_level_on`, name: `${lab}: auto level on` },
				{ variableId: `${p}target`, name: `${lab}: auto level target dB` },
				{ variableId: `${p}cal`, name: `${lab}: calibrate level dB` },
				{ variableId: `${p}level`, name: `${lab}: level auto level sees dB` },
				{ variableId: `${p}rms`, name: `${lab}: post-fader average dB` },
				{ variableId: `${p}peak`, name: `${lab}: post-fader peak dB` },
				{ variableId: `${p}pre`, name: `${lab}: pre-fader peak dB` },
				{ variableId: `${p}pfl`, name: `${lab}: PFL (solo) on` },
				{ variableId: `${p}backup_for`, name: `${lab}: is the backup for` },
				{ variableId: `${p}on_backup`, name: `${lab}: switched to this backup` },
			)
			for (const b of inp.blocks) {
				const k = kindOf(b.kind)
				defs.push({ variableId: `${p}${b.id}_on`, name: `${lab}: ${b.name} on` })
				for (const prm of k?.params ?? []) defs.push({ variableId: `${p}${b.id}_${prm.key}`, name: `${lab}: ${b.name} ${prm.label}` })
				if (k?.gainReduction) defs.push({ variableId: `${p}${b.id}_gr`, name: `${lab}: ${b.name} gain reduction dB` })
			}
		})
		return Object.fromEntries(defs.map((d) => [d.variableId, { name: d.name }]))
	}

	#stateVariables(): CompanionVariableValues {
		const ver = this.engine.versions
		const x = this.device?.extras()
		const v: CompanionVariableValues = {
			connected: this.engine.connected,
			inputs: this.engine.visible().length,
			module_version: ver.moduleVersion,
			module_latest: ver.moduleLatest ?? '',
			module_update: ver.moduleUpdate,
			atem_model: x?.model ?? '',
			atem_mixer: this.engine.connected ? (x?.mixer ?? '') : '',
			atem_protocol: ver.deviceVersion ?? '',
			atem_error: this.engine.connected ? '' : this.engine.deviceError,
			afv_crossfade: x?.afvCrossfade ?? '',
			auto_level_count: this.engine.visible().filter((i) => this.engine.settings(i.id).autoLevelOn).length,
			...this.#urlVariables(),
			...this.#recordVariables(),
			rec_folder_problem: this.#folderProblem,
			solo: this.engine.inputs.get(this.engine.monitoring.solo ?? '')?.name ?? [...this.engine.inputs.values()].find((i) => i.monitor === 'solo')?.name ?? '',
			notices: this.engine.notices.list.length,
			notice: this.engine.notices.list.at(-1)?.title ?? '',
			...this.engine.recordings.variableValues(),
		}
		this.engine.visible().forEach((inp, idx) => {
			const p = `in${idx + 1}_`
			const set = this.engine.settings(inp.id)
			const rec = this.engine.store.inputs[inp.id]
			v[`${p}name`] = inp.name
			v[`${p}id`] = inp.id
			v[`${p}vol`] = fmtDb(inp.volumeDb)
			v[`${p}trim`] = inp.caps.trim ? inp.trimDb.toFixed(1) : ''
			v[`${p}mute`] = inp.muted
			v[`${p}mix`] = inp.mixOption
			v[`${p}bal`] = inp.caps.balance ? Math.round((inp.balance - 0.5) * 200) : ''
			v[`${p}delay`] = inp.caps.delay ? inp.delay : ''
			v[`${p}auto_level`] = inp.autoLevel.state
			v[`${p}auto_level_on`] = set.autoLevelOn
			v[`${p}target`] = rec?.target === null || rec?.target === undefined ? '' : rec.target.toFixed(1)
			v[`${p}cal`] = set.calibrateDb
			v[`${p}pfl`] = this.engine.monitoring.pflShown(inp)
			v[`${p}backup_for`] = this.engine.backups.mainOf(inp)?.name ?? ''
			v[`${p}on_backup`] = this.engine.backups.onBackup(inp.id)
			for (const b of inp.blocks) {
				const k = kindOf(b.kind)
				v[`${p}${b.id}_on`] = b.enabled
				for (const prm of k?.params ?? []) {
					const val = b.settings[prm.key]
					v[`${p}${b.id}_${prm.key}`] = typeof val === 'number' ? Math.round(val * 100) / 100 : String(val ?? '')
				}
			}
		})
		return v
	}

	#recordVariables(): CompanionVariableValues {
		const r = this.engine.recorder.state
		const plan = this.engine.store.record
		const cd = this.engine.recorder.countdown()
		const x = this.device?.extras()
		const fmt = (s: number) => {
			const a = Math.abs(s)
			const hh = Math.floor(a / 3600)
			const mm = Math.floor((a % 3600) / 60)
			const ss = a % 60
			return `${s < 0 ? '-' : ''}${hh ? `${hh}:` : ''}${String(mm).padStart(2, '0')}:${String(ss).padStart(2, '0')}`
		}
		const left = x?.recording?.secondsLeft ?? null
		return {
			rec_state: r.active ? 'recording' : 'stopped',
			rec_time: r.timecode ? r.timecode.split('.')[0] : '',
			rec_next: plan.nextStart ? new Date(plan.nextStart).toTimeString().slice(0, 5) : '',
			rec_countdown: cd === null ? '' : fmt(cd),
			rec_auto: !!plan.nextStart && plan.autoStart,
			rec_folder: r.directory,
			rec_files: r.fileCount ?? '',
			rec_file_name: x?.recording?.fileName ?? '',
			rec_disk: x?.recording?.disk ?? '',
			rec_remaining: left === null ? '' : fmt(left),
			rec_remaining_s: left ?? '',
			rec_error: x?.recording?.error ?? '',
			rec_iso: x?.recording?.iso ?? '',
			stream_state: x?.streaming?.state ?? '',
			stream_time: x?.streaming?.duration ?? '',
			stream_bitrate: x?.streaming?.bitrate ?? '',
		}
	}

	#meterVariables(): void {
		const v: CompanionVariableValues = {}
		const max = (a: Db[]) => a.reduce<Db>((m, x) => (x !== null && (m === null || x > m) ? x : m), null)
		this.engine.visible().forEach((inp, idx) => {
			const p = `in${idx + 1}_`
			v[`${p}level`] = fmtDb(inp.autoLevel.level)
			v[`${p}rms`] = fmtDb(max(inp.postMag))
			v[`${p}peak`] = fmtDb(max(inp.postPeak))
			v[`${p}pre`] = fmtDb(max(inp.prePeak))
			for (const b of inp.blocks) if (kindOf(b.kind)?.gainReduction) v[`${p}${b.id}_gr`] = (inp.gainReduction[b.id] ?? 0).toFixed(1)
		})
		Object.assign(v, this.#recordVariables())
		this.setVariableValues(v)
		this.checkFeedbacks('level_above', 'pickup_led', 'recording', 'streaming', 'rec_upload_failed', 'rec_override')
	}

	// ---- actions ------------------------------------------------------------------

	#actions(): CompanionActionDefinitions {
		const e = this.engine
		const modeChoices = (extra: DropdownChoice[] = []): DropdownChoice[] => [{ id: 'set', label: 'Set to' }, { id: 'adjust', label: 'Adjust by' }, ...extra]
		const onOffToggle: DropdownChoice[] = [
			{ id: 'toggle', label: 'Toggle' },
			{ id: 'on', label: 'On' },
			{ id: 'off', label: 'Off' },
		]
		const flip = (mode: unknown, current: boolean) => (mode === 'on' ? true : mode === 'off' ? false : !current)
		const settingChoices = Object.entries(e.schema.fields).map(([k, f]) => ({ id: k, label: f.label }))
		const ticked = this.#tickedFields()
		const bus = (o: CompanionOptionValues) => {
			const id = this.#text(o, 'bus')
			const inp = e.inputs.get(id)
			if (!inp) this.log('warn', `This ATEM hasn't got ${BUS_CHOICES.find((c) => c.id === id)?.label.toLowerCase() ?? id} I can drive`)
			return inp
		}

		return {
			ag_button: {
				name: 'Auto gain: the input button (press / double tap / hold)',
				description:
					'Put "pressed" in the button\'s press actions and "released" in its release actions. Press = this level please, double tap = calibrate to the input\'s level, hold = calibrate to the module level.',
				options: [
					inputOption,
					{
						type: 'dropdown',
						label: 'Button',
						id: 'edge',
						default: 'down',
						choices: [
							{ id: 'down', label: 'Pressed' },
							{ id: 'up', label: 'Released' },
						],
					},
				],
				callback: async ({ options }) => {
					const inp = this.#input(options)
					if (!inp) return
					if (options.edge === 'up') e.buttonUp(inp)
					else e.buttonDown(inp)
				},
			},
			ag_capture: {
				name: 'Auto gain: this level please',
				description: 'Capture the current level as the auto level target',
				options: [inputOption],
				callback: async ({ options }) => {
					const inp = this.#input(options)
					if (inp) e.captureTarget(inp)
				},
			},
			ag_calibrate: {
				name: 'Auto gain: calibrate',
				options: [
					inputOption,
					{
						type: 'dropdown',
						label: 'To',
						id: 'to',
						default: 'input',
						disableAutoExpression: true,
						choices: [
							{ id: 'input', label: "The input's own calibrate level" },
							{ id: 'module', label: 'The module calibrate level' },
							{ id: 'custom', label: 'A level given here' },
						],
					},
					{ type: 'textinput', label: 'Level (dB)', id: 'level', default: '-18', useVariables: true, isVisibleExpression: "$(options:to) == 'custom'" },
				],
				callback: async ({ options }) => {
					const inp = this.#input(options)
					if (!inp) return
					if (options.to === 'custom') {
						const db = parseNumber(this.#text(options, 'level'), NaN, -100, 26)
						if (Number.isNaN(db)) return this.log('warn', "Calibrate: the level isn't a number")
						e.calibrate(inp, db)
					} else e.calibrate(inp, options.to === 'module' ? 'module' : 'input')
				},
			},
			ag_auto_level: {
				name: 'Auto gain: auto level on / off',
				options: [inputOption, { type: 'dropdown', label: 'Auto level', id: 'mode', default: 'toggle', choices: onOffToggle }],
				callback: async ({ options }) => {
					const inp = this.#input(options)
					if (inp) e.setInputSetting(inp.id, 'autoLevelOn', flip(options.mode, e.settings(inp.id).autoLevelOn))
				},
			},
			ag_target: {
				name: 'Auto gain: set the auto level target',
				options: [
					inputOption,
					{ type: 'dropdown', label: 'Mode', id: 'mode', default: 'set', disableAutoExpression: true, choices: modeChoices([{ id: 'clear', label: 'Clear the target' }]) },
					{ type: 'textinput', label: 'dB', id: 'db', default: '-18', useVariables: true, isVisibleExpression: "$(options:mode) != 'clear'" },
				],
				callback: async ({ options }) => {
					const inp = this.#input(options)
					if (!inp) return
					if (options.mode === 'clear') return e.setTarget(inp, null)
					const n = parseNumber(this.#text(options, 'db'), NaN, -100, 26)
					if (Number.isNaN(n)) return
					const cur = e.store.inputs[inp.id]?.target ?? null
					if (options.mode === 'adjust') {
						if (cur === null) return this.log('warn', `${inp.name} has no target to adjust`)
						e.setTarget(inp, cur + n)
					} else e.setTarget(inp, n)
				},
			},
			ag_setting: {
				name: 'Auto gain: change a setting',
				description: 'Any auto gain setting, for one input or the page-wide defaults',
				options: [
					{
						type: 'dropdown',
						label: 'For',
						id: 'scope',
						default: 'input',
						disableAutoExpression: true,
						choices: [
							{ id: 'input', label: 'One input' },
							{ id: 'default', label: 'The defaults (every input that has not changed it)' },
						],
					},
					{ ...inputOption, isVisibleExpression: "$(options:scope) == 'input'" },
					{ type: 'dropdown', label: 'Setting', id: 'key', default: 'bandDb', choices: settingChoices },
					{
						type: 'textinput',
						label: 'Value',
						id: 'value',
						default: '',
						useVariables: true,
						tooltip: 'A number, on/off, or a choice (e.g. fader, trim, rms, peak). For one input, "default" goes back to the page-wide default.',
					},
				],
				callback: async ({ options }) => {
					const key = String(options.key)
					const value = this.#text(options, 'value')
					if (options.scope === 'default') return e.setDefaultSetting(key, value)
					const inp = this.#input(options)
					if (inp) e.setInputSetting(inp.id, key, value.toLowerCase() === 'default' ? undefined : value)
				},
			},
			volume: {
				name: 'Fader: set level',
				description: 'Any strip: an input, the master, the headphones or talkback',
				options: [
					inputOption,
					{ type: 'dropdown', label: 'Mode', id: 'mode', default: 'set', disableAutoExpression: true, choices: modeChoices() },
					{ type: 'textinput', label: 'dB (or -inf)', id: 'db', default: '0', useVariables: true },
					{ type: 'textinput', label: 'Fade time (ms, 0 = instant)', id: 'fade', default: '0', useVariables: true, isVisibleExpression: "$(options:mode) == 'set'" },
				],
				callback: async ({ options }) => {
					const inp = this.#input(options)
					if (!inp) return
					const db = parseDb(this.#text(options, 'db'))
					if (db === undefined) return this.log('warn', "Fader: the level isn't a number")
					const hi = inp.caps.fader.maxDb
					if (options.mode === 'adjust') {
						if (inp.volumeDb === null || db === null) return
						e.setVolume(inp, clamp(inp.volumeDb + db, MIN_DB, hi))
					} else e.setVolume(inp, db === null ? null : clamp(db, MIN_DB, hi), parseNumber(this.#text(options, 'fade'), 0, 0, 600000))
				},
			},
			volume_grid: {
				name: 'Fader: from a value (Intech Grid fader), with pickup',
				description: "Sets an input's fader from a number or variable, e.g. a Grid fader's 0-127. Fader N drives the Nth input in the list unless an input is given.",
				options: [
					{ type: 'textinput', label: 'Fader number', id: 'fader', default: '1', useVariables: true, tooltip: 'Which input in the list it drives (1 = first). Can be a variable, for banking.' },
					{ type: 'textinput', label: 'Input (blank = by fader number)', id: 'input', default: '', useVariables: true, tooltip: INPUT_TIP },
					{ type: 'textinput', label: 'Value', id: 'value', default: '', useVariables: true },
					{
						type: 'dropdown',
						label: 'Value is',
						id: 'valueType',
						default: 'position',
						disableAutoExpression: true,
						choices: [
							{ id: 'position', label: 'Fader position 0-127 (e.g. Grid fader)' },
							{ id: 'db', label: 'Level in dB (-inf, or -100 to +10)' },
						],
					},
					{
						type: 'checkbox',
						label: 'Pickup mode',
						id: 'pickup',
						default: true,
						disableAutoExpression: true,
						tooltip:
							"Don't change the ATEM until the fader sits within the catch band of the ATEM's level for the dwell time, then stay latched until the ATEM is moved elsewhere. Show the state with the 'Grid fader pickup LED' feedback.",
						isVisibleExpression: "$(options:valueType) != 'db'",
					},
					{ type: 'textinput', label: "Catch band (blank = this connection's setting)", id: 'band', default: '', useVariables: true, isVisibleExpression: "$(options:valueType) != 'db' && $(options:pickup)" },
					{ type: 'textinput', label: "Dwell time ms (blank = this connection's setting)", id: 'dwell', default: '', useVariables: true, isVisibleExpression: "$(options:valueType) != 'db' && $(options:pickup)" },
					{
						type: 'textinput',
						label: "Release band (blank = this connection's setting)",
						id: 'releaseBand',
						default: '',
						useVariables: true,
						tooltip: `Once latched, only an ATEM-side move bigger than this lets go. ${NEVER_RELEASE_BAND} = never. Leave blank to use the connection's setting.`,
						isVisibleExpression: "$(options:valueType) != 'db' && $(options:pickup)",
					},
					{ type: 'textinput', label: "Release time ms (blank = this connection's setting)", id: 'releaseMs', default: '', useVariables: true, isVisibleExpression: "$(options:valueType) != 'db' && $(options:pickup)" },
				],
				callback: async ({ options }) => {
					const fader = parseNumber(this.#text(options, 'fader'), 1, 1, 999)
					const inp = e.gridInput(Math.round(fader), this.#text(options, 'input'))
					if (!inp) return
					const raw = this.#text(options, 'value')
					if (options.valueType === 'db') {
						const db = parseDb(raw)
						if (db !== undefined) e.setVolume(inp, db === null ? null : clamp(db, MIN_DB, inp.caps.fader.maxDb))
						return
					}
					const n = Number(raw)
					if (raw === '' || Number.isNaN(n)) return
					const incoming = clamp(n, 0, 127)
					const send = (pos: number) => e.setVolume(inp, positionToDb(pos / 127, e.law))
					if (options.pickup !== true) return send(incoming)
					const g = this.#resolved?.grid ?? { band: DEFAULT_BAND, dwellMs: DEFAULT_DWELL_MS, releaseBand: DEFAULT_RELEASE_BAND, releaseMs: DEFAULT_RELEASE_MS }
					const settings = {
						band: parseNumber(this.#text(options, 'band'), g.band, 0, 64),
						dwellMs: parseNumber(this.#text(options, 'dwell'), g.dwellMs, 0, 10000),
						releaseBand: parseNumber(this.#text(options, 'releaseBand'), g.releaseBand, 0, NEVER_RELEASE_BAND),
						releaseMs: parseNumber(this.#text(options, 'releaseMs'), g.releaseMs, 0, 60000),
					}
					if (e.pickup.handle(inp.id, incoming, settings, send)) send(incoming)
				},
			},
			trim: {
				name: 'Trim: set level',
				description: "A Fairlight input's trim (input gain before the EQ, dynamics and fader). Classic ATEMs haven't got one.",
				options: [
					inputOption,
					{ type: 'dropdown', label: 'Mode', id: 'mode', default: 'set', choices: modeChoices() },
					{ type: 'textinput', label: 'dB (-60 to +6)', id: 'db', default: '0', useVariables: true },
				],
				callback: async ({ options }) => {
					const inp = this.#input(options)
					if (!inp) return
					if (!inp.caps.trim) return this.log('warn', `${inp.name} has no trim`)
					const n = parseNumber(this.#text(options, 'db'), NaN, -100, 100)
					if (Number.isNaN(n)) return
					e.setTrim(inp, clamp(options.mode === 'adjust' ? inp.trimDb + n : n, inp.caps.trim.minDb, inp.caps.trim.maxDb))
				},
			},
			mute: {
				name: 'Input: mute (the ATEM\'s "off")',
				description: 'Mute turns the input off. Unmute puts back what it was before: on, or audio follow video. Talkback and the headphones\' programme feed have their own mute.',
				options: [inputOption, { type: 'dropdown', label: 'Mute', id: 'mode', default: 'toggle', choices: onOffToggle }],
				callback: async ({ options }) => {
					const inp = this.#input(options)
					if (!inp) return
					if (!inp.caps.mute) return this.log('warn', `${inp.name} has no mute`)
					await e.setMute(inp, flip(options.mode, inp.muted))
				},
			},
			mix_option: {
				name: 'Input: on / off / audio follow video',
				options: [inputOption, { type: 'dropdown', label: 'Set to', id: 'value', default: 'toggle_on', choices: MIX_CHOICES }],
				callback: async ({ options }) => {
					const inp = this.#input(options)
					if (!inp) return
					if (!inp.caps.mixOption) return this.log('warn', `${inp.name} has no on / off / AFV`)
					let v = this.#text(options, 'value')
					if (v === 'toggle_on') v = inp.mixOption === 'off' ? 'on' : 'off'
					if (v === 'toggle_afv') v = inp.mixOption === 'off' ? 'afv' : 'off'
					await e.setMixOption(inp, v)
				},
			},
			balance: {
				name: 'Input: balance / pan',
				options: [
					inputOption,
					{ type: 'dropdown', label: 'Mode', id: 'mode', default: 'set', choices: modeChoices() },
					{ type: 'textinput', label: 'Balance (-100 = left, 0 = centre, 100 = right)', id: 'value', default: '0', useVariables: true },
				],
				callback: async ({ options }) => {
					const inp = this.#input(options)
					if (!inp) return
					if (!inp.caps.balance) return this.log('warn', `${inp.name} has no balance`)
					const n = parseNumber(this.#text(options, 'value'), NaN, -200, 200)
					if (Number.isNaN(n)) return
					const cur = (inp.balance - 0.5) * 200
					await e.setBalance(inp, (clamp(options.mode === 'adjust' ? cur + n : n, -100, 100) + 100) / 200)
				},
			},
			delay: {
				name: 'Input: delay (frames)',
				description: 'Fairlight inputs that have it (usually the analog ones, up to 8 frames).',
				options: [
					inputOption,
					{ type: 'dropdown', label: 'Mode', id: 'mode', default: 'set', choices: modeChoices() },
					{ type: 'textinput', label: 'Frames', id: 'value', default: '0', useVariables: true },
				],
				callback: async ({ options }) => {
					const inp = this.#input(options)
					if (!inp) return
					if (!inp.caps.delay) return this.log('warn', `${inp.name} has no delay`)
					const n = parseNumber(this.#text(options, 'value'), NaN)
					if (Number.isNaN(n)) return
					await e.setDelay(inp, options.mode === 'adjust' ? inp.delay + n : n)
				},
			},
			block_enable: {
				name: 'Processing: EQ, band or dynamics on / off',
				description: 'Fairlight inputs and the master (the master has no expander).',
				options: [
					inputOption,
					{ type: 'dropdown', label: 'Block', id: 'block', default: 'compressor', choices: BLOCK_CHOICES },
					{ type: 'dropdown', label: 'Set', id: 'mode', default: 'toggle', choices: onOffToggle },
				],
				callback: async ({ options }) => {
					const inp = this.#input(options)
					if (!inp) return
					const id = this.#text(options, 'block')
					const b = inp.blocks.find((x) => x.id === id)
					if (!b) return this.log('warn', `${inp.name} has no ${BLOCK_CHOICES.find((c) => c.id === id)?.label ?? id}`)
					await e.setBlockEnabled(inp, b.id, flip(options.mode, b.enabled))
				},
			},
			block_set: {
				name: 'Processing: change an EQ or dynamics setting',
				options: [
					inputOption,
					{ type: 'dropdown', label: 'Setting', id: 'param', default: `${COMPRESSOR_KIND}:threshold`, choices: ALL_PARAMS.map((p) => ({ id: p.id, label: p.label })) },
					{ type: 'textinput', label: 'EQ band (1-6)', id: 'band', default: '1', useVariables: true, tooltip: 'Only for EQ band settings.' },
					{ type: 'dropdown', label: 'Mode', id: 'mode', default: 'set', choices: modeChoices() },
					{ type: 'textinput', label: 'Value', id: 'value', default: '', useVariables: true, tooltip: 'dB, ms, Hz, n:1 or Q as the setting says. Shapes: low shelf, low pass, bell, notch, high pass, high shelf.' },
				],
				callback: async ({ options }) => {
					const inp = this.#input(options)
					if (!inp) return
					const p = ALL_PARAMS.find((x) => x.id === options.param)
					if (!p) return
					const blockId = p.kind.kind === BAND_KIND ? `band${Math.round(parseNumber(this.#text(options, 'band'), 1, 1, BAND_COUNT))}` : BLOCK_OF_KIND[p.kind.kind]
					const b = inp.blocks.find((x) => x.id === blockId)
					if (!b) return this.log('warn', `${inp.name} has no ${p.kind.label}`)
					const raw = this.#text(options, 'value')
					let value: unknown = raw
					if (p.param.type === 'number') {
						const n = Number(raw)
						if (raw === '' || Number.isNaN(n)) return this.log('warn', `${p.label}: "${raw}" isn't a number`)
						const cur = Number(b.settings[p.param.key] ?? p.param.default)
						value = clamp(options.mode === 'adjust' ? cur + n : n, p.param.min ?? -Infinity, p.param.max ?? Infinity)
					} else if (p.param.type === 'choice') {
						const c = p.param.choices?.find((c) => c.id.toLowerCase() === raw.toLowerCase() || c.label.toLowerCase() === raw.toLowerCase())
						if (!c) return this.log('warn', `"${raw}" isn't a choice for ${p.label}`)
						value = c.id
					}
					await e.setBlockParam(inp, b.id, p.param.key, value)
				},
			},
			processing_reset: {
				name: 'Processing: reset EQ, dynamics or peak meters',
				options: [
					inputOption,
					{
						type: 'dropdown',
						label: 'Reset',
						id: 'what',
						default: 'peaks',
						choices: [
							{ id: 'eq', label: 'The EQ (all bands)' },
							{ id: 'dynamics', label: 'The dynamics' },
							{ id: 'peaks', label: 'The peak meters' },
						],
					},
				],
				callback: async ({ options }) => {
					const inp = this.#input(options)
					if (!inp) return
					const what = options.what === 'eq' ? 'eq' : options.what === 'dynamics' ? 'dynamics' : 'peaks'
					await this.#dev(`Reset ${what} on ${inp.name}`, (d) => d.reset(inp.id, what))
				},
			},
			peaks_reset_all: {
				name: 'Meters: reset every peak on the ATEM',
				options: [],
				callback: async () => this.#dev('Reset peaks', (d) => d.resetAllPeaks()),
			},
			bus_level: {
				name: 'Headphones / talkback: set level',
				description: "The headphone or monitor out, its programme feed, talkback and sidetone, on models that have them. (They're strips too, so any fader action works on them.)",
				options: [
					{ type: 'dropdown', label: 'Which', id: 'bus', default: 'monitor', choices: BUS_CHOICES },
					{ type: 'dropdown', label: 'Mode', id: 'mode', default: 'set', disableAutoExpression: true, choices: modeChoices() },
					{ type: 'textinput', label: 'dB (or -inf)', id: 'db', default: '0', useVariables: true },
				],
				callback: async ({ options }) => {
					const inp = bus(options)
					if (!inp) return
					const db = parseDb(this.#text(options, 'db'))
					if (db === undefined) return this.log('warn', "Headphones: the level isn't a number")
					const { minDb, maxDb } = inp.caps.fader
					if (options.mode === 'adjust') {
						if (inp.volumeDb === null || db === null) return
						e.setVolume(inp, clamp(inp.volumeDb + db, minDb, maxDb))
					} else e.setVolume(inp, db === null ? null : clamp(db, minDb, maxDb))
				},
			},
			bus_mute: {
				name: 'Headphones / talkback: mute',
				description: "Talkback and the headphones' programme feed (Fairlight), or the monitor out (classic). The ATEM has no talk on / off as such: this is the talkback level into the headphones.",
				options: [
					{ type: 'dropdown', label: 'Which', id: 'bus', default: 'talkback', choices: BUS_CHOICES },
					{ type: 'dropdown', label: 'Mute', id: 'mode', default: 'toggle', choices: onOffToggle },
				],
				callback: async ({ options }) => {
					const inp = bus(options)
					if (!inp) return
					if (!inp.caps.mute) return this.log('warn', `${inp.name} has no mute on this ATEM`)
					await e.setMute(inp, flip(options.mode, inp.muted))
				},
			},
			monitor_dim: {
				name: 'Monitor: dim (classic ATEMs)',
				options: [{ type: 'dropdown', label: 'Dim', id: 'mode', default: 'toggle', choices: onOffToggle }],
				callback: async ({ options }) => {
					const cur = !!this.device?.state?.audio?.monitor?.dim
					await this.#dev('Monitor dim', (d) => d.setDim(flip(options.mode, cur)))
				},
			},
			afv_crossfade: {
				name: 'ATEM: audio follow video crossfades on transitions',
				options: [{ type: 'dropdown', label: 'Crossfade', id: 'mode', default: 'toggle', choices: onOffToggle }],
				callback: async ({ options }) => {
					const cur = !!this.device?.extras().afvCrossfade
					await this.#dev('AFV crossfade', (d) => d.setAfvCrossfade(flip(options.mode, cur)))
				},
			},
			input_config: {
				name: 'Input: stereo or split into two mono channels (Fairlight)',
				description: 'Split = dual mono: the input becomes two strips, ch 1 and ch 2. Their settings start fresh.',
				options: [
					inputOption,
					{
						type: 'dropdown',
						label: 'Make it',
						id: 'config',
						default: 'dualmono',
						choices: [
							{ id: 'stereo', label: 'Stereo' },
							{ id: 'dualmono', label: 'Dual mono (split)' },
							{ id: 'mono', label: 'Mono' },
						],
					},
				],
				callback: async ({ options }) => {
					const inp = this.#input(options)
					if (!inp) return
					const c = options.config === 'stereo' ? 'stereo' : options.config === 'mono' ? 'mono' : 'dualmono'
					await this.#dev(`Channels of ${inp.name}`, (d) => d.setInputConfig(inp.id, c))
				},
			},
			input_level: {
				name: 'Input: mic or line level (Fairlight analog inputs)',
				options: [
					inputOption,
					{
						type: 'dropdown',
						label: 'Level',
						id: 'level',
						default: 'mic',
						choices: [
							{ id: 'mic', label: 'Mic' },
							{ id: 'line', label: 'Line (consumer)' },
							{ id: 'proline', label: 'Line (pro)' },
						],
					},
				],
				callback: async ({ options }) => {
					const inp = this.#input(options)
					if (!inp) return
					const l = options.level === 'line' ? 'line' : options.level === 'proline' ? 'proline' : 'mic'
					await this.#dev(`Input level of ${inp.name}`, (d) => d.setInputLevel(inp.id, l))
				},
			},
			pfl: {
				name: "Input: PFL (the ATEM's solo, headphones only)",
				description: "Uses the ATEM's solo, so you hear it on the headphone / monitor out. Never changes the programme or the recording. The ATEM solos one thing at a time.",
				options: [inputOption, { type: 'dropdown', label: 'PFL', id: 'mode', default: 'toggle', choices: onOffToggle }],
				callback: async ({ options }) => {
					const inp = this.#input(options)
					if (!inp) return
					if (!inp.caps.monitor) return this.log('warn', `${inp.name} can't be soloed on this ATEM (it needs a headphone or monitor out)`)
					await e.monitoring.setPfl(inp, flip(options.mode, e.monitoring.pflShown(inp)))
				},
			},
			solo: {
				name: 'Input: solo (hear only this input on the headphones)',
				description:
					'While soloed you hear only this input on the headphones; ending the solo puts the PFL back as it was. Never changes the programme or the recording. For press-and-hold, put "On" in the press actions and "Off" in the release actions.',
				options: [
					inputOption,
					{
						type: 'dropdown',
						label: 'Solo',
						id: 'mode',
						default: 'toggle',
						choices: [
							{ id: 'toggle', label: 'Toggle (latching)' },
							{ id: 'on', label: 'On (e.g. on press)' },
							{ id: 'off', label: 'Off (e.g. on release)' },
						],
					},
				],
				callback: async ({ options }) => {
					const inp = this.#input(options)
					if (inp) await e.monitoring.setSolo(inp, flip(options.mode, e.monitoring.solo === inp.id))
				},
			},
			backup_switch: {
				name: 'Backup: switch between main and backup',
				description: 'The input given is the backup feed (its "This is the backup for" setting names the main).',
				options: [
					{ ...inputOption, label: 'Backup input (name, number or id)' },
					{
						type: 'dropdown',
						label: 'Switch to',
						id: 'to',
						default: 'toggle',
						choices: [
							{ id: 'toggle', label: 'Toggle' },
							{ id: 'backup', label: 'The backup' },
							{ id: 'main', label: 'The main' },
						],
					},
				],
				callback: async ({ options }) => {
					const inp = this.#input(options)
					if (!inp) return
					if (!e.backups.mainOf(inp)) return this.log('warn', `${inp.name} isn't set as a backup for another input`)
					const toBackup = options.to === 'backup' || (options.to === 'toggle' && !e.backups.onBackup(inp.id))
					if (toBackup) e.backups.switchToBackup(inp, 'it was switched by hand')
					else e.backups.switchToMain(inp)
				},
			},
			auto_level_all: {
				name: 'Auto gain: auto level on / off for every input',
				options: [
					{
						type: 'dropdown',
						label: 'Auto level',
						id: 'mode',
						default: 'off',
						choices: [
							{ id: 'on', label: 'All on' },
							{ id: 'off', label: 'All off' },
						],
					},
				],
				callback: ({ options }) => {
					for (const inp of e.visible()) if (!inp.caps.role) e.setInputSetting(inp.id, 'autoLevelOn', options.mode === 'on')
				},
			},
			record: {
				name: "Recording: start / stop (the ATEM's own)",
				description: 'ATEMs with a recorder (ATEM Mini Pro and up, software 8.1.1 or later). Stopping from a button happens straight away (the fader page asks twice first).',
				options: [
					{
						type: 'dropdown',
						label: 'Recording',
						id: 'mode',
						default: 'toggle',
						choices: [
							{ id: 'start', label: 'Start' },
							{ id: 'stop', label: 'Stop' },
							{ id: 'toggle', label: 'Toggle start / stop' },
						],
					},
				],
				callback: async ({ options }) => {
					const r = e.recorder
					try {
						if (options.mode === 'start' || (options.mode === 'toggle' && !r.state.active)) await r.start()
						else await r.stop()
					} catch (err) {
						this.log('warn', `Recording: ${(err as Error).message}`)
					}
				},
			},
			record_plan: {
				name: 'Recording: plan the next start',
				options: [
					{ type: 'textinput', label: 'Time (HH:MM, today or tomorrow if already past; blank = clear the plan)', id: 'time', default: '', useVariables: true },
					{ type: 'checkbox', label: 'Start recording automatically at that time', id: 'auto', default: false },
				],
				callback: async ({ options }) => {
					const t = this.#text(options, 'time')
					if (!t) return e.recorder.setPlan(null, false)
					const m = /^(\d{1,2}):(\d{2})$/.exec(t)
					if (!m) return this.log('warn', `Recording plan: "${t}" isn't a time like 14:30`)
					const d = new Date()
					d.setHours(Number(m[1]), Number(m[2]), 0, 0)
					if (d.getTime() < Date.now()) d.setDate(d.getDate() + 1)
					e.recorder.setPlan(d.toISOString(), options.auto === true)
				},
			},
			record_name: {
				name: 'Recording: set the file name',
				description: 'The ATEM adds its own number to each file. Up to 128 bytes. Set it before you start.',
				options: [
					{ type: 'textinput', label: 'File name', id: 'name', default: '', useVariables: true },
					{ type: 'checkbox', label: 'Add the date and time (YYYY-MM-DD HHMM)', id: 'stamp', default: false },
				],
				callback: async ({ options }) => {
					let name = this.#text(options, 'name')
					if (options.stamp === true) {
						const d = new Date()
						const p = (n: number) => String(n).padStart(2, '0')
						name = `${name ? `${name} ` : ''}${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}${p(d.getMinutes())}`
					}
					if (!name) return this.log('warn', "Recording file name: it's blank, so I've left it as it was")
					try {
						await e.recorder.setFileName(name.replace(/[\\/:*?"<>|]/g, '-'))
					} catch (err) {
						this.log('warn', `Recording file name: ${(err as Error).message}`)
					}
				},
			},
			record_iso: {
				name: 'Recording: ISO (record every input) on / off',
				options: [{ type: 'dropdown', label: 'ISO', id: 'mode', default: 'toggle', choices: onOffToggle }],
				callback: async ({ options }) => {
					const cur = !!this.device?.extras().recording?.iso
					await this.#dev('ISO recording', (d) => d.setIso(flip(options.mode, cur)))
				},
			},
			record_disk: {
				name: 'Recording: switch to the other disk',
				options: [],
				callback: async () => this.#dev('Switch disk', (d) => d.switchDisk()),
			},
			stream: {
				name: "Streaming: start / stop (the ATEM's own)",
				options: [
					{
						type: 'dropdown',
						label: 'Streaming',
						id: 'mode',
						default: 'toggle',
						choices: [
							{ id: 'start', label: 'Start' },
							{ id: 'stop', label: 'Stop' },
							{ id: 'toggle', label: 'Toggle start / stop' },
						],
					},
				],
				callback: async ({ options }) => {
					const s = this.device?.extras().streaming?.state
					const on = options.mode === 'start' || (options.mode === 'toggle' && (s === 'idle' || s === undefined))
					await this.#dev('Streaming', (d) => d.setStreaming(on))
				},
			},
			page_setting: {
				name: 'Fader page: change a setting',
				description: 'Any fader page setting (colours, layout, meters, PFL mode...). The same settings as on the page.',
				options: [
					{ type: 'dropdown', label: 'Setting', id: 'key', default: 'layout', choices: PAGE_SETTING_CHOICES },
					{ type: 'textinput', label: 'Value', id: 'value', default: '', useVariables: true, tooltip: 'A number, true/false, a colour like #7a2fe0, or a choice (e.g. strips, rows, additive, exclusive).' },
				],
				callback: async ({ options }) => {
					e.setPage(String(options.key) as keyof PageSettings, this.#text(options, 'value'))
				},
			},
			notices_dismiss: {
				name: 'Fader page: dismiss all pop-ups',
				options: [],
				callback: () => {
					for (const n of [...e.notices.list]) void e.noticeAction(n.id, 'dismiss')
				},
			},
			open_page: {
				name: 'Fader page: open it on this computer',
				description: 'Opens the fader page in the default web browser of the computer Companion runs on.',
				options: [],
				callback: () => {
					const url = this.#pageUrls().find((u) => u.includes('127.0.0.1')) ?? this.#pageUrls()[0]
					if (!url) return this.log('warn', 'The fader page is off (its port is 0)')
					openInBrowser(url, (m) => this.log('warn', m))
				},
			},
			check_updates: {
				name: 'Check for module updates now',
				options: [],
				callback: async () => {
					await e.checkUpdates()
				},
			},
			connection_set: {
				name: 'Connection: set settings',
				description:
					"Changes this connection's settings, for the fields ticked \"Can be set by the action\" on the connection page. Blank = leave as is. Put it in a trigger on \"variable changed\" to drive the connection from a variable.",
				options: ticked.length
					? ticked.map(
							(f): CompanionInputFieldTextInput => ({
								type: 'textinput',
								id: f,
								label: CONN_LABELS[f],
								default: '',
								useVariables: true,
								tooltip:
									f === 'webBind'
										? "all, local, or one of this computer's addresses. Blank = leave as is."
										: NUMBER_FIELDS.has(f)
											? `A whole number from ${NUMBER_RANGES[f][0]} to ${NUMBER_RANGES[f][1]}. Blank = leave as is.`
											: 'Blank = leave as is.',
							}),
						)
					: [
							{
								type: 'static-text',
								id: 'none',
								label: 'Nothing to set yet',
								value: "Tick \"Can be set by the action\" next to a field on this connection's settings page first. Then it turns up here, ready to set.",
							},
						],
				callback: async ({ options }) => {
					await this.#setByAction(options)
				},
			},
			rec_row: {
				name: 'Recordings: sheet row (next / previous / set / release)',
				description: 'Which spreadsheet row names the next recording. Release lets go of a manual pick when the rows are matched by time.',
				options: [
					{
						type: 'dropdown',
						label: 'Do',
						id: 'op',
						default: 'next',
						choices: [
							{ id: 'next', label: 'Next row' },
							{ id: 'previous', label: 'Previous row' },
							{ id: 'set', label: 'Set the row' },
							{ id: 'release', label: 'Release (back to matching by time)' },
						],
					},
					{
						type: 'textinput',
						label: 'Row',
						id: 'value',
						default: '1',
						useVariables: true,
						tooltip: 'A row number (1 = the first row under the column names), or a value from the key column (e.g. a session code). Can be a variable.',
						isVisibleExpression: "$(options:op) == 'set'",
					},
					{
						type: 'dropdown',
						label: 'Look it up by',
						id: 'how',
						default: 'auto',
						choices: [
							{ id: 'auto', label: 'Key column first, then row number' },
							{ id: 'key', label: 'Key column value' },
							{ id: 'number', label: 'Row number' },
						],
						isVisibleExpression: "$(options:op) == 'set'",
					},
				],
				callback: ({ options }) => {
					const r = e.recordings
					const op = String(options.op)
					if (op === 'release') return r.rowRelease()
					const ok = op === 'next' ? r.rowNext() : op === 'previous' ? r.rowPrevious() : r.rowSet(this.#text(options, 'value'), String(options.how ?? 'auto') as 'auto' | 'key' | 'number')
					if (!ok) this.log('info', op === 'set' ? `Recordings: no sheet row "${this.#text(options, 'value')}", so the row stays as it was` : `Recordings: no ${op} row (or no sheet yet)`)
				},
			},
			rec_upload: {
				name: 'Recordings: upload now / retry failed / clear done',
				options: [
					{
						type: 'dropdown',
						label: 'Do',
						id: 'op',
						default: 'now',
						choices: [
							{ id: 'now', label: 'Upload everything waiting, now' },
							{ id: 'retry', label: 'Retry the failed ones' },
							{ id: 'clear', label: 'Clear finished uploads from the list' },
						],
					},
				],
				callback: ({ options }) => {
					const r = e.recordings
					if (options.op === 'retry') this.log('info', `Recordings: ${r.retryFailed()} upload(s) trying again`)
					else if (options.op === 'clear') r.clearFinished(false)
					else this.log('info', `Recordings: ${r.uploadNow(false)} file(s) on their way`)
				},
			},
			rec_sheet_refresh: {
				name: 'Recordings: read the Google Sheet again now',
				options: [],
				callback: async () => {
					await e.recordings.refreshSheet()
					const st = e.recordings.rec.sheet.status
					if (st.error) this.log('warn', `Recordings: sheet: ${st.error}`)
				},
			},
			rec_naming: {
				name: 'Recordings: sheet naming and uploads on / off',
				options: [
					{
						type: 'dropdown',
						label: 'Set',
						id: 'mode',
						default: 'toggle',
						choices: [
							{ id: 'on', label: 'On' },
							{ id: 'off', label: 'Off' },
							{ id: 'toggle', label: 'Toggle' },
						],
					},
				],
				callback: ({ options }) => {
					const on = options.mode === 'toggle' ? !e.recordings.enabled : options.mode === 'on'
					e.recordings.setEnabled(on)
				},
			},
			rec_name_value: {
				name: 'Recordings: set a value for the name',
				description: 'Gives the naming a value to use as {var:name}, e.g. from a Companion variable or expression. Takes effect on the next recording.',
				options: [
					{ type: 'textinput', label: 'Name (as in {var:name})', id: 'key', default: 'session', useVariables: true, tooltip: 'Letters, numbers and _ are safest' },
					{ type: 'textinput', label: 'Value', id: 'value', default: '', useVariables: true, tooltip: 'Blank clears it. Can be a variable.' },
				],
				callback: ({ options }) => {
					const key = this.#text(options, 'key')
					if (!key) return this.log('info', 'Recordings: set a value for the name: no name given, so nothing set')
					const v = this.#text(options, 'value')
					if (v === '') delete this.#nameVars[key]
					else this.#nameVars[key] = v
					e.recordings.setVars({ ...this.#nameVars })
				},
			},
			refresh: {
				name: 'Re-read everything from the ATEM',
				options: [],
				callback: async () => {
					await e.refreshAll()
				},
			},
		}
	}

	// ---- feedbacks ----------------------------------------------------------------

	#feedbacks(): CompanionFeedbackDefinitions {
		const e = this.engine
		const colourOpt = (id: string, label: string, def: string, tooltip?: string) =>
			({ type: 'textinput', label, id, default: def, useVariables: true, tooltip: tooltip ?? '#rrggbb, r,g,b or a variable. Blank = leave as is.' }) as const
		const inputFor = (o: CompanionOptionValues) => e.resolve(this.#text(o, 'input'))
		const max = (a: Db[]) => a.reduce<Db>((m, x) => (x !== null && (m === null || x > m) ? x : m), null)
		return {
			auto_level_status: {
				type: 'advanced',
				name: 'Auto gain: auto level status colours',
				affectedProperties: ['bgcolor'],
				description: 'Background colour for what auto level is doing on an input',
				options: [inputOption, ...AUTOLEVEL_STATES.map((s) => colourOpt(`c_${s.id}`, s.label, STATUS_COLOURS[s.id]))],
				callback: (fb) => {
					const inp = inputFor(fb.options)
					if (!inp) return {}
					const c = parseColour(this.#text(fb.options, `c_${inp.autoLevel.state}`), undefined)
					return c === undefined ? {} : { bgcolor: c }
				},
			},
			auto_level_on: {
				type: 'boolean',
				name: 'Auto gain: auto level is on',
				defaultStyle: { bgcolor: rgb(85, 0, 170), color: rgb(255, 255, 255) },
				options: [inputOption],
				callback: (fb) => {
					const inp = inputFor(fb.options)
					return !!inp && e.settings(inp.id).autoLevelOn
				},
			},
			pfl_on: {
				type: 'boolean',
				name: 'Input: PFL (solo) is on',
				defaultStyle: { bgcolor: rgb(0, 120, 60), color: rgb(255, 255, 255) },
				options: [inputOption],
				callback: (fb) => {
					const inp = inputFor(fb.options)
					return !!inp && e.monitoring.pflShown(inp)
				},
			},
			solo_on: {
				type: 'boolean',
				name: 'Input: soloed',
				defaultStyle: { bgcolor: rgb(200, 150, 0), color: rgb(0, 0, 0) },
				options: [inputOption],
				callback: (fb) => inputFor(fb.options)?.id === e.monitoring.solo,
			},
			muted: {
				type: 'boolean',
				name: 'Input: muted (off)',
				defaultStyle: { bgcolor: rgb(200, 0, 0), color: rgb(255, 255, 255) },
				options: [inputOption],
				callback: (fb) => !!inputFor(fb.options)?.muted,
			},
			mix_option_is: {
				type: 'boolean',
				name: 'Input: on / off / AFV is',
				defaultStyle: { bgcolor: rgb(0, 120, 60), color: rgb(255, 255, 255) },
				options: [
					inputOption,
					{
						type: 'dropdown',
						label: 'Is',
						id: 'value',
						default: 'on',
						choices: [
							{ id: 'on', label: 'On' },
							{ id: 'off', label: 'Off' },
							{ id: 'afv', label: 'Audio follow video' },
							{ id: 'ftb', label: 'Master: follows fade to black' },
							{ id: 'free', label: 'Master: ignores fade to black' },
						],
					},
				],
				callback: (fb) => inputFor(fb.options)?.mixOption === this.#text(fb.options, 'value'),
			},
			block_on: {
				type: 'boolean',
				name: 'Processing: EQ, band or dynamics is on',
				defaultStyle: { bgcolor: rgb(0, 120, 60), color: rgb(255, 255, 255) },
				options: [inputOption, { type: 'dropdown', label: 'Block', id: 'block', default: 'compressor', choices: BLOCK_CHOICES }],
				callback: (fb) => !!inputFor(fb.options)?.blocks.find((b) => b.id === this.#text(fb.options, 'block'))?.enabled,
			},
			on_backup: {
				type: 'boolean',
				name: 'Backup: switched to the backup',
				defaultStyle: { bgcolor: rgb(200, 100, 0), color: rgb(255, 255, 255) },
				options: [{ ...inputOption, label: 'Backup input (name, number or id)' }],
				callback: (fb) => {
					const inp = inputFor(fb.options)
					return !!inp && e.backups.onBackup(inp.id)
				},
			},
			recording: {
				type: 'boolean',
				name: 'Recording: is',
				defaultStyle: { bgcolor: rgb(200, 0, 0), color: rgb(255, 255, 255) },
				options: [
					{
						type: 'dropdown',
						label: 'State',
						id: 'state',
						default: 'active',
						choices: [
							{ id: 'active', label: 'Recording' },
							{ id: 'stopped', label: 'Stopped' },
							{ id: 'due', label: 'Due to start (a start time is planned)' },
							{ id: 'problem', label: 'The ATEM reports a problem (no disk, disk full...)' },
						],
					},
				],
				callback: (fb) => {
					const r = e.recorder.state
					if (fb.options.state === 'stopped') return !r.active
					if (fb.options.state === 'due') return !r.active && !!e.store.record.nextStart
					if (fb.options.state === 'problem') return !!this.device?.extras().recording?.error
					return r.active
				},
			},
			streaming: {
				type: 'boolean',
				name: 'Streaming: is',
				defaultStyle: { bgcolor: rgb(200, 0, 0), color: rgb(255, 255, 255) },
				options: [
					{
						type: 'dropdown',
						label: 'State',
						id: 'state',
						default: 'streaming',
						choices: [
							{ id: 'streaming', label: 'Streaming' },
							{ id: 'connecting', label: 'Connecting' },
							{ id: 'stopping', label: 'Stopping' },
							{ id: 'idle', label: 'Idle' },
						],
					},
				],
				callback: (fb) => this.device?.extras().streaming?.state === fb.options.state,
			},
			afv_crossfade: {
				type: 'boolean',
				name: 'ATEM: audio follow video crossfades on transitions',
				defaultStyle: { bgcolor: rgb(85, 0, 170), color: rgb(255, 255, 255) },
				options: [],
				callback: () => !!this.device?.extras().afvCrossfade,
			},
			rec_upload_failed: {
				type: 'boolean',
				name: 'Recordings: an upload has failed',
				defaultStyle: { bgcolor: rgb(200, 0, 0), color: rgb(255, 255, 255) },
				options: [],
				callback: () => e.recordings.uploadFailed,
			},
			rec_uploading: {
				type: 'boolean',
				name: 'Recordings: uploading or waiting to upload',
				defaultStyle: { bgcolor: rgb(85, 0, 170), color: rgb(255, 255, 255) },
				options: [],
				callback: () => {
					const s = e.recordings.rec.uploads.summary()
					return s.uploading + s.queued + s.retrying > 0
				},
			},
			rec_override: {
				type: 'boolean',
				name: 'Recordings: a manual row pick is overriding the time match',
				defaultStyle: { bgcolor: rgb(200, 100, 0), color: rgb(255, 255, 255) },
				options: [],
				callback: () => e.recordings.overrideActive,
			},
			rec_sheet_problem: {
				type: 'boolean',
				name: "Recordings: the sheet can't be read",
				defaultStyle: { bgcolor: rgb(200, 100, 0), color: rgb(255, 255, 255) },
				options: [],
				callback: () => {
					const st = e.recordings.rec.sheet.status
					return st.kind !== 'none' && !!st.error
				},
			},
			notice_active: {
				type: 'boolean',
				name: 'Fader page: a pop-up is waiting',
				defaultStyle: { bgcolor: rgb(200, 100, 0), color: rgb(255, 255, 255) },
				options: [],
				callback: () => e.notices.list.length > 0,
			},
			connected: {
				type: 'boolean',
				name: 'Connected to the ATEM',
				defaultStyle: { bgcolor: rgb(0, 120, 60), color: rgb(255, 255, 255) },
				options: [],
				callback: () => e.connected,
			},
			update_available: {
				type: 'boolean',
				name: 'Update available',
				description: 'A newer ATEM Audio module is out (checked on GitHub, see the connection settings)',
				defaultStyle: { bgcolor: rgb(85, 0, 170), color: rgb(255, 255, 255) },
				options: [],
				callback: () => e.versions.moduleUpdate,
			},
			level_above: {
				type: 'boolean',
				name: 'Meter: level (or gain reduction) at or above',
				defaultStyle: { bgcolor: rgb(200, 0, 0), color: rgb(255, 255, 255) },
				options: [
					inputOption,
					{
						type: 'dropdown',
						label: 'Meter',
						id: 'meter',
						default: 'peak',
						choices: [
							{ id: 'peak', label: 'Post-fader peak' },
							{ id: 'rms', label: 'Post-fader average' },
							{ id: 'pre', label: 'Pre-fader peak' },
							{ id: 'level', label: 'What auto level sees' },
							{ id: 'gr_expander', label: 'Expander / gate gain reduction (dB, positive)' },
							{ id: 'gr_compressor', label: 'Compressor gain reduction (dB, positive)' },
							{ id: 'gr_limiter', label: 'Limiter gain reduction (dB, positive)' },
						],
					},
					{ type: 'textinput', label: 'Threshold (dB)', id: 'db', default: '-6', useVariables: true },
				],
				callback: (fb) => {
					const inp = inputFor(fb.options)
					if (!inp) return false
					const th = parseNumber(this.#text(fb.options, 'db'), 0)
					const m = String(fb.options.meter)
					if (m.startsWith('gr_')) return (inp.gainReduction[m.slice(3)] ?? 0) >= th
					const v = m === 'rms' ? max(inp.postMag) : m === 'pre' ? max(inp.prePeak) : m === 'level' ? inp.autoLevel.level : max(inp.postPeak)
					return v !== null && v >= th
				},
			},
			pickup_led: {
				type: 'advanced',
				name: 'Grid fader pickup LED',
				affectedProperties: ['bgcolor'],
				description: 'Background colour for a Grid fader using pickup. Same as the SQ module extension.',
				options: [
					{ type: 'textinput', label: 'Fader number', id: 'fader', default: '1', useVariables: true },
					{ type: 'textinput', label: 'Input (blank = by fader number)', id: 'input', default: '', useVariables: true, tooltip: INPUT_TIP },
					{ type: 'textinput', label: 'Fader value', id: 'value', default: '', useVariables: true },
					colourOpt('belowColour', 'Below the ATEM level: colour', '#ff0000'),
					{ type: 'checkbox', label: 'Below the ATEM level: flash', id: 'belowFlash', default: true },
					colourOpt('aboveColour', 'Above the ATEM level: colour', '#ff0000'),
					{ type: 'checkbox', label: 'Above the ATEM level: flash', id: 'aboveFlash', default: false },
					colourOpt('catchColour', 'Catching: colour', '#00ff00'),
					colourOpt('trackingColour', 'Tracking: colour (brightness follows the fader)', '#ffffff'),
					{ type: 'textinput', label: 'Flash speed (ms per on/off)', id: 'flashMs', default: String(DEFAULT_FLASH_MS), useVariables: true },
				],
				callback: (fb) => {
					const o = fb.options
					const fader = parseNumber(this.#text(o, 'fader'), 1, 1, 999)
					const inp = e.gridInput(Math.round(fader), this.#text(o, 'input'))
					if (!inp) return {}
					const raw = this.#text(o, 'value')
					const n = Number(raw)
					const { led, position } = e.pickup.ledState(inp.id, raw === '' || Number.isNaN(n) ? undefined : n)
					const flashMs = parseNumber(this.#text(o, 'flashMs'), DEFAULT_FLASH_MS, 50, 5000)
					const off = Math.floor(Date.now() / flashMs) % 2 === 1
					const col = (id: string, def: number) => parseColour(this.#text(o, id), def) ?? def
					switch (led) {
						case 'below':
							return { bgcolor: o.belowFlash && off ? BLACK : col('belowColour', rgb(255, 0, 0)) }
						case 'above':
							return { bgcolor: o.aboveFlash && off ? BLACK : col('aboveColour', rgb(255, 0, 0)) }
						case 'catch':
							return { bgcolor: col('catchColour', rgb(0, 255, 0)) }
						default:
							return { bgcolor: scaleColour(col('trackingColour', rgb(255, 255, 255)), position / 127) }
					}
				},
			},
		}
	}

	// ---- presets ------------------------------------------------------------------

	#presets(): { structure: CompanionPresetSection<AtemAudioTypes>[]; presets: CompanionPresetDefinitions<AtemAudioTypes> } {
		const presets: CompanionPresetDefinitions<AtemAudioTypes> = {}
		const structure: CompanionPresetSection<AtemAudioTypes>[] = []
		const white = rgb(255, 255, 255)
		const purple = rgb(85, 0, 170)
		const green = rgb(0, 120, 60)
		const red = rgb(200, 0, 0)
		const L = this.label
		const section = (id: string, name: string) => {
			structure.push({ id, name, definitions: [] })
		}
		const button = (
			id: string,
			name: string,
			text: string,
			down: { actionId: string; options: CompanionOptionValues }[],
			feedbacks: { feedbackId: string; options: CompanionOptionValues; style?: { bgcolor?: number; color?: number } }[] = [],
			up: { actionId: string; options: CompanionOptionValues }[] = [],
		) => {
			presets[id] = {
				type: 'simple',
				name,
				style: { text, size: 'auto', color: white, bgcolor: BLACK },
				steps: [{ down, up }],
				feedbacks,
			}
			;(structure[structure.length - 1].definitions as string[]).push(id)
		}
		const statusColours = (i: string) => ({ input: i, ...Object.fromEntries(AUTOLEVEL_STATES.map((st) => [`c_${st.id}`, STATUS_COLOURS[st.id]])) })
		const x = this.device?.extras()

		section('overall', 'ATEM Audio')
		button('open_page', 'Open the fader page (on this computer)', 'FADER\\nPAGE', [{ actionId: 'open_page', options: {} }])
		button('page_url', 'Fader page address', '$(' + L + ':page_url)', [], [])
		button('connected', 'ATEM connection', 'ATEM\\n$(' + L + ':atem_mixer)', [], [{ feedbackId: 'connected', options: {}, style: { bgcolor: green } }])
		button('update', 'Update available', 'UPDATE', [{ actionId: 'open_page', options: {} }], [{ feedbackId: 'update_available', options: {}, style: { bgcolor: purple } }])
		button('auto_level_on', 'Auto level on for every input', 'ALL AUTO\\nLEVEL\\nON', [{ actionId: 'auto_level_all', options: { mode: 'on' } }])
		button('auto_level_off', 'Auto level off for every input', 'ALL AUTO\\nLEVEL\\nOFF', [{ actionId: 'auto_level_all', options: { mode: 'off' } }])
		button('record', 'Record start / stop', 'REC\\n$(' + L + ':rec_time)', [{ actionId: 'record', options: { mode: 'toggle' } }], [
			{ feedbackId: 'recording', options: { state: 'active' }, style: { bgcolor: red } },
			{ feedbackId: 'recording', options: { state: 'problem' }, style: { bgcolor: rgb(150, 100, 0) } },
		])
		button('record_left', 'Recording: time left on the disk', 'DISK\\n$(' + L + ':rec_remaining)', [], [{ feedbackId: 'recording', options: { state: 'problem' }, style: { bgcolor: rgb(150, 100, 0) } }])
		button('record_next', 'Next recording start and countdown', 'NEXT REC\\n$(' + L + ':rec_next)\\n$(' + L + ':rec_countdown)', [], [
			{ feedbackId: 'recording', options: { state: 'due' }, style: { bgcolor: purple } },
		])
		button('stream', 'Stream start / stop', 'STREAM\\n$(' + L + ':stream_time)', [{ actionId: 'stream', options: { mode: 'toggle' } }], [
			{ feedbackId: 'streaming', options: { state: 'streaming' }, style: { bgcolor: red } },
			{ feedbackId: 'streaming', options: { state: 'connecting' }, style: { bgcolor: rgb(150, 100, 0) } },
		])
		button('afv_crossfade', 'Audio follow video crossfade on / off', 'AFV\\nXFADE', [{ actionId: 'afv_crossfade', options: { mode: 'toggle' } }], [
			{ feedbackId: 'afv_crossfade', options: {}, style: { bgcolor: purple } },
		])
		button('peaks_reset', 'Reset every peak meter', 'RESET\\nPEAKS', [{ actionId: 'peaks_reset_all', options: {} }])
		button('notices', 'Pop-ups waiting (press to dismiss all)', 'POP-UPS\\n$(' + L + ':notices)', [{ actionId: 'notices_dismiss', options: {} }], [
			{ feedbackId: 'notice_active', options: {}, style: { bgcolor: rgb(200, 100, 0) } },
		])
		if (x?.mixer === 'classic' || !x) {
			button('dim', 'Monitor dim (classic ATEMs)', 'MON\\nDIM', [{ actionId: 'monitor_dim', options: { mode: 'toggle' } }])
		}

		section('recordings', 'Recordings (sheet naming and uploads)')
		button('rec_row_prev', 'Previous sheet row', 'ROW\n◀\n$(' + L + ':rec_row)', [{ actionId: 'rec_row', options: { op: 'previous', value: '1', how: 'auto' } }])
		button('rec_row_next', 'Next sheet row', 'ROW\n▶\n$(' + L + ':rec_row)', [{ actionId: 'rec_row', options: { op: 'next', value: '1', how: 'auto' } }])
		button('rec_row_release', 'Release the manual row pick (back to time matching)', 'ROW\nRELEASE', [{ actionId: 'rec_row', options: { op: 'release', value: '1', how: 'auto' } }], [
			{ feedbackId: 'rec_override', options: {}, style: { bgcolor: rgb(200, 100, 0) } },
		])
		button('rec_next_name', 'Next take name', 'NEXT:\n$(' + L + ':rec_next_name)', [], [{ feedbackId: 'rec_sheet_problem', options: {}, style: { bgcolor: rgb(200, 100, 0) } }])
		button('rec_upload_now', 'Upload now', 'UPLOAD\n$(' + L + ':rec_up_waiting) waiting', [{ actionId: 'rec_upload', options: { op: 'now' } }], [
			{ feedbackId: 'rec_uploading', options: {}, style: { bgcolor: purple } },
			{ feedbackId: 'rec_upload_failed', options: {}, style: { bgcolor: rgb(200, 0, 0) } },
		])
		button('rec_upload_retry', 'Retry failed uploads', 'RETRY\n$(' + L + ':rec_up_failed) failed', [{ actionId: 'rec_upload', options: { op: 'retry' } }], [
			{ feedbackId: 'rec_upload_failed', options: {}, style: { bgcolor: rgb(200, 0, 0) } },
		])
		button('rec_sheet_refresh', 'Read the sheet again', 'SHEET\n$(' + L + ':rec_sheet)', [{ actionId: 'rec_sheet_refresh', options: {} }], [
			{ feedbackId: 'rec_sheet_problem', options: {}, style: { bgcolor: rgb(200, 100, 0) } },
		])

		this.engine.visible().forEach((inp, idx) => {
			const n = idx + 1
			const i = String(n)
			const k = inp.caps
			section(`input_${n}`, `${k.role ? 'Bus' : 'Input'} ${n}: ${inp.name}`)
			const name = `$(${L}:in${n}_name)`
			if (!k.role) {
				button(`ag_${n}`, 'Auto gain button: press = this level, double tap = calibrate, hold = calibrate to module level', `${name}\\nAG $(${L}:in${n}_target)`, [{ actionId: 'ag_button', options: { input: i, edge: 'down' } }], [{ feedbackId: 'auto_level_status', options: statusColours(i) }], [
					{ actionId: 'ag_button', options: { input: i, edge: 'up' } },
				])
				button(`auto_level_${n}`, 'Auto level on / off', `${name}\\nAUTO\\nLEVEL`, [{ actionId: 'ag_auto_level', options: { input: i, mode: 'toggle' } }], [
					{ feedbackId: 'auto_level_on', options: { input: i }, style: { bgcolor: purple, color: white } },
				])
				button(`status_${n}`, 'Auto level status and target', `${name}\\n$(${L}:in${n}_auto_level)\\n$(${L}:in${n}_target)`, [], [{ feedbackId: 'auto_level_status', options: statusColours(i) }])
				button(`capture_${n}`, 'This level please', `${name}\\nTHIS\\nLEVEL`, [{ actionId: 'ag_capture', options: { input: i } }])
				button(`cal_${n}`, "Calibrate to the input's level", `${name}\\nCAL\\n$(${L}:in${n}_cal)`, [{ actionId: 'ag_calibrate', options: { input: i, to: 'input' } }])
				button(`calm_${n}`, 'Calibrate to the module level', `${name}\\nCAL\\nMODULE`, [{ actionId: 'ag_calibrate', options: { input: i, to: 'module' } }])
			}
			if (k.mute) {
				button(`mute_${n}`, k.mixOption ? 'Mute (off), unmute puts back on / AFV' : 'Mute', `${name}\\nMUTE`, [{ actionId: 'mute', options: { input: i, mode: 'toggle' } }], [
					{ feedbackId: 'muted', options: { input: i }, style: { bgcolor: red, color: white } },
				])
			}
			if (k.mixOption && !k.role) {
				button(`on_${n}`, 'On / off', `${name}\\nON`, [{ actionId: 'mix_option', options: { input: i, value: 'toggle_on' } }], [
					{ feedbackId: 'mix_option_is', options: { input: i, value: 'on' }, style: { bgcolor: green, color: white } },
				])
				if (k.mixOption.choices.some((c) => c.id === 'afv')) {
					button(`afv_${n}`, 'Audio follow video / off', `${name}\\nAFV`, [{ actionId: 'mix_option', options: { input: i, value: 'toggle_afv' } }], [
						{ feedbackId: 'mix_option_is', options: { input: i, value: 'afv' }, style: { bgcolor: rgb(150, 100, 0), color: white } },
					])
				}
			}
			if (k.role === 'master' && k.mixOption) {
				button(`ftb_${n}`, 'Master follows fade to black', `${name}\\nFTB`, [{ actionId: 'mix_option', options: { input: i, value: inp.mixOption === 'ftb' ? 'free' : 'ftb' } }], [
					{ feedbackId: 'mix_option_is', options: { input: i, value: 'ftb' }, style: { bgcolor: purple, color: white } },
				])
			}
			if (k.monitor) {
				button(`pfl_${n}`, 'PFL (solo on the headphones)', `${name}\\nPFL`, [{ actionId: 'pfl', options: { input: i, mode: 'toggle' } }], [
					{ feedbackId: 'pfl_on', options: { input: i }, style: { bgcolor: green, color: white } },
				])
				button(`solo_${n}`, 'Solo (hold)', `${name}\\nSOLO`, [{ actionId: 'solo', options: { input: i, mode: 'on' } }], [{ feedbackId: 'solo_on', options: { input: i }, style: { bgcolor: rgb(200, 150, 0), color: BLACK } }], [
					{ actionId: 'solo', options: { input: i, mode: 'off' } },
				])
				button(`solol_${n}`, 'Solo (latching)', `${name}\\nSOLO\\nLATCH`, [{ actionId: 'solo', options: { input: i, mode: 'toggle' } }], [
					{ feedbackId: 'solo_on', options: { input: i }, style: { bgcolor: rgb(200, 150, 0), color: BLACK } },
				])
			}
			button(`level_${n}`, 'Level readout', `${name}\\n$(${L}:in${n}_vol) dB\\n$(${L}:in${n}_peak)`, [], [
				{ feedbackId: 'level_above', options: { input: i, meter: 'peak', db: '-18' }, style: { bgcolor: rgb(0, 100, 0) } },
				{ feedbackId: 'level_above', options: { input: i, meter: 'peak', db: '-6' }, style: { bgcolor: rgb(150, 120, 0) } },
				{ feedbackId: 'level_above', options: { input: i, meter: 'peak', db: '-1' }, style: { bgcolor: red } },
			])
			for (const [id, label, mode, db] of [
				['up1', '+1 dB', 'adjust', '1'],
				['dn1', '-1 dB', 'adjust', '-1'],
				['up3', '+3 dB', 'adjust', '3'],
				['dn3', '-3 dB', 'adjust', '-3'],
				['unity', '0 dB', 'set', '0'],
			]) {
				button(`fader_${id}_${n}`, `Fader ${label}`, `${name}\\nFADER\\n${label}`, [{ actionId: 'volume', options: { input: i, mode, db, fade: '0' } }])
			}
			if (k.trim) {
				button(`trim_up_${n}`, 'Trim +1 dB', `${name}\\nTRIM\\n+1 dB`, [{ actionId: 'trim', options: { input: i, mode: 'adjust', db: '1' } }])
				button(`trim_dn_${n}`, 'Trim -1 dB', `${name}\\nTRIM\\n-1 dB`, [{ actionId: 'trim', options: { input: i, mode: 'adjust', db: '-1' } }])
			}
			if (k.delay) {
				button(`delay_up_${n}`, 'Delay +1 frame', `${name}\\nDELAY\\n+1 $(${L}:in${n}_delay)`, [{ actionId: 'delay', options: { input: i, mode: 'adjust', value: '1' } }])
				button(`delay_dn_${n}`, 'Delay -1 frame', `${name}\\nDELAY\\n-1 $(${L}:in${n}_delay)`, [{ actionId: 'delay', options: { input: i, mode: 'adjust', value: '-1' } }])
			}
			for (const b of inp.blocks) {
				if (b.kind === BAND_KIND) continue
				const short = b.id === 'eq' ? 'EQ' : b.id === 'expander' ? 'EXP' : b.id === 'compressor' ? 'COMP' : 'LIMIT'
				const gr = kindOf(b.kind)?.gainReduction
				button(`block_${n}_${b.id}`, `${b.name} on / off`, `${name}\\n${short}${gr ? `\\nGR $(${L}:in${n}_${b.id}_gr)` : ''}`, [{ actionId: 'block_enable', options: { input: i, block: b.id, mode: 'toggle' } }], [
					{ feedbackId: 'block_on', options: { input: i, block: b.id }, style: { bgcolor: green, color: white } },
				])
			}
			if (this.engine.backups.mainOf(inp)) {
				button(`backup_${n}`, 'Switch between main and this backup', `${name}\\nBACKUP`, [{ actionId: 'backup_switch', options: { input: i, to: 'toggle' } }], [
					{ feedbackId: 'on_backup', options: { input: i }, style: { bgcolor: rgb(200, 100, 0), color: white } },
				])
			}
		})
		return { structure, presets }
	}
}

/** A hand-made change (fader page or the ATEM itself) as one of this module's actions, for the action recorder */
export function recordedAction(c: UserChange): { actionId: string; options: CompanionOptionValues; key: string } | undefined {
	const input = c.input
	switch (c.kind) {
		case 'volume':
			return { actionId: 'volume', options: { input, mode: 'set', db: c.db === null ? '-inf' : c.db.toFixed(1), fade: '0' }, key: `vol:${input}` }
		case 'trim':
			return { actionId: 'trim', options: { input, mode: 'set', db: String(c.db) }, key: `trim:${input}` }
		case 'mute':
			return { actionId: 'mute', options: { input, mode: c.muted ? 'on' : 'off' }, key: `mute:${input}` }
		case 'mixOption':
			return { actionId: 'mix_option', options: { input, value: c.value }, key: `mix:${input}` }
		case 'balance':
			return { actionId: 'balance', options: { input, mode: 'set', value: String(Math.round((c.balance - 0.5) * 200)) }, key: `bal:${input}` }
		case 'delay':
			return { actionId: 'delay', options: { input, mode: 'set', value: String(c.value) }, key: `delay:${input}` }
		case 'monitor':
			return { actionId: 'pfl', options: { input, mode: c.value === 'solo' ? 'on' : 'off' }, key: `pfl:${input}` }
		case 'blockEnabled':
			return { actionId: 'block_enable', options: { input, block: c.block.id, mode: c.on ? 'on' : 'off' }, key: `bon:${input}:${c.block.id}` }
		case 'blockParam': {
			const band = /^band(\d)$/.exec(c.block.id)
			return {
				actionId: 'block_set',
				options: { input, param: `${c.block.kind}:${c.key}`, band: band ? band[1] : '1', mode: 'set', value: String(c.value) },
				key: `b:${input}:${c.block.id}:${c.key}`,
			}
		}
		default:
			return undefined
	}
}
