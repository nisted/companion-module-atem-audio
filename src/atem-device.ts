/**
 * An ATEM as a core Device (see core/src/device.ts). Works with both of the
 * ATEM's audio mixers:
 *
 *  - Fairlight (ATEM Minis, SDI, TVS HD8, Constellations...): every source of
 *    every input is a strip (a dual-mono input gives two: "ch 1" and "ch 2"),
 *    with trim, fader, pan, on / off / AFV, frame delay, the EQ and its six
 *    bands, expander / gate, compressor (with make-up gain) and limiter, and
 *    gain-reduction meters. The programme master is a strip too (fader, EQ,
 *    compressor, limiter, follow fade-to-black), and so are the headphone /
 *    monitor out and talkback levels on models that have them.
 *  - Classic (older TVS, 1/2/4 M/E...): gain (the fader), balance, on / off /
 *    AFV, master, monitor and headphones. Meters come through our patch (see
 *    classic-levels.ts).
 *
 * The ATEM's state comes from atem-connection through an AtemLink. Whenever
 * it changes, the whole input list is rebuilt from the state and compared
 * with the last one, and only the differences go to the core.
 *
 * Input ids: 'in<audio input>' for a stereo (or the only) source, e.g. in1,
 * in1001; 'in<input>.1' / '.2' for the two halves of a dual-mono input;
 * 'in<input>:<source>' for anything else; and 'master', 'monitor',
 * 'phones', 'phones_prog', 'talkback', 'sidetone' for the buses.
 */

import type { Db } from '../core/src/law.js'
import type { BlockInfo, Device, DeviceHost, DeviceInfo, DeviceInputState, DeviceMeter, DeviceRecording, InputCaps } from '../core/src/device.js'
import type { EngineOptions } from '../core/src/engine.js'
import type { AtemState, Fairlight } from 'atem-connection'
import type { AtemCalls, AtemLink } from './atem-link.js'
import type { ClassicLevels } from './classic-levels.js'
import {
	BAND_COUNT,
	BAND_KIND,
	COMPRESSOR_KIND,
	EQ_KIND,
	EXPANDER_KIND,
	FAIRLIGHT_KINDS,
	LIMITER_KIND,
	atemKey,
	bandId,
	bandIndex,
	checkParam,
	rangeId,
	shapeId,
	toAtem,
} from './atem-processing.js'
import {
	CL_MIX,
	DISK_STATUS,
	FL_MIX,
	FL_SOURCE_MONO,
	FTP_MODELS,
	MIX_LABELS,
	PORT,
	REC_ERROR,
	REC_STATUS,
	SPLIT_MONITOR_MODELS,
	SRC_CH1,
	SRC_CH2,
	SRC_STEREO,
	STREAM_STATUS,
	audioInputLabel,
	clMixId,
	dbToFl,
	flGainReduction,
	flLevelToMul,
	flMixId,
	flToDb,
	protocolText,
	type MixId,
} from './atem-values.js'
import { MODULE_VERSION } from './version.js'

export const MODULE_REPO = 'nisted/companion-module-atem-audio'
export const ATEM_PORT = 9910

/** How long without a connection before "looking for it" becomes "can't reach it" */
const UNREACHABLE_MS = 6000
/** Meters go to the core at most this often */
const METER_MS = 50
/** No meters from the ATEM for this long while connected: ask for them again */
const METERS_QUIET_MS = 1500

export const ATEM_INFO: DeviceInfo = {
	label: 'the ATEM',
	software: { label: 'ATEM software', repo: '', download: 'https://www.blackmagicdesign.com/support/family/atem-live-production-switchers' },
	processing: FAIRLIGHT_KINDS,
	tips: [
		"The ATEM only solos one thing at a time, so PFL on another input swaps over rather than adding up.",
		'Mute here is the ATEM\'s "off". Unmute puts back whatever it was before: on, or audio follow video.',
		'On a Fairlight ATEM, auto level can ride the trim and leave the fader to you. Have a look in Show advanced.',
		"Older (classic) ATEMs have no trim, EQ or dynamics, so those bits just don't show up.",
		'Each connection to an ATEM uses one of its control slots, and it hasn\'t got many. Close what you don\'t need.',
	],
}

/** How ATEM Audio sets up the core engine */
export function atemEngineOptions(): EngineOptions {
	return {
		appId: 'atem-audio',
		appName: 'ATEM Audio',
		moduleVersion: MODULE_VERSION,
		routingLabel: 'Routing',
		updates: {
			moduleRepo: MODULE_REPO,
			deviceRepo: '',
			moduleDownload: `https://github.com/${MODULE_REPO}/releases`,
			deviceDownload: ATEM_INFO.software.download,
			userAgent: 'companion-module-atem-audio',
		},
	}
}

export type MixerType = 'fairlight' | 'classic' | 'none'

/** Where one strip lives on the ATEM */
type Where =
	| { t: 'fl'; index: number; source: string }
	| { t: 'flMaster' }
	| { t: 'flMonitor'; part: 'gain' | 'prog' | 'talkback' | 'sidetone' }
	| { t: 'cl'; index: number }
	| { t: 'clMaster' }
	| { t: 'clMonitor' }
	| { t: 'clPhones'; part: 'gain' | 'prog' | 'talkback' | 'sidetone' }

interface Strip {
	state: DeviceInputState
	where: Where
}

const FTB_CHOICES = [
	{ id: 'ftb', label: 'Follows fade to black' },
	{ id: 'free', label: 'Ignores fade to black' },
]
const SOLO_MONITOR = { choices: [{ id: 'off', label: 'Off' }, { id: 'solo', label: 'Solo' }], off: 'off', pfl: 'solo' }

export interface AtemDeviceOptions {
	host: string
	port: number
	/** Makes the AtemLink (the real one in main.ts, a pretend one in tests) */
	makeLink: () => AtemLink
	/** Where the ATEM's recordings can be read from this computer ('' = nowhere) */
	recordingsFolder?: string
	/** How long without an answer before saying it can't be reached (default 6 s) */
	unreachableMs?: number
	/** How long without meters before asking the ATEM for them again (default 1.5 s) */
	metersQuietMs?: number
}

/** Extra ATEM state for Companion variables and feedbacks (things the core doesn't model) */
export interface AtemExtras {
	mixer: MixerType
	model: string
	protocol: string
	afvCrossfade: boolean | null
	recording: null | { state: 'idle' | 'recording' | 'stopping'; error: string; secondsLeft: number | null; disk: string; fileName: string; iso: boolean | null; duration: string }
	streaming: null | { state: 'idle' | 'connecting' | 'streaming' | 'stopping'; duration: string; bitrate: number | null }
	ftp: boolean
}

export class AtemDevice implements Device {
	readonly info = ATEM_INFO
	#host: DeviceHost | null = null
	#link: AtemLink | null = null
	#strips = new Map<string, Strip>()
	#order: string[] = []
	#published = false
	#lastError = ''
	#since = 0
	#everConnected = false
	#publishTimer: NodeJS.Timeout | null = null
	#meterTimer: NodeJS.Timeout | null = null
	#errTimer: NodeJS.Timeout | null = null
	#durTimer: NodeJS.Timeout | null = null
	#pendingMeters = new Map<string, DeviceMeter>()
	/** When meters last arrived, and when we last asked for them */
	#levelsAt = 0
	#levelsAskedAt = 0
	#metersQuiet = false
	/** Meter diagnostics, logged every 10 s (debug) */
	#mstat = { src: 0, master: 0, classic: 0, unmatched: 0, at: Date.now(), last: '' }
	/** What the mix option was before a mute, to put back on unmute */
	#beforeMute = new Map<string, MixId>()
	/** Classic gains we sent (the ATEM rounds them a little), id -> dB and when */
	#sentClassic = new Map<string, { db: Db; at: number }>()
	#recActive: boolean | null = null
	#stopped = false
	/** The solo we last asked for (strip id, or null for none) and when: the ATEM's answer takes a moment */
	#soloWant: { id: string | null; at: number } | null = null

	constructor(readonly opts: AtemDeviceOptions) {}

	get connected(): boolean {
		return !!this.#link?.connected && !!this.#link.state
	}

	get lastError(): string {
		return this.connected ? '' : this.#lastError
	}

	get mixer(): MixerType {
		const s = this.#link?.state
		return s?.fairlight ? 'fairlight' : s?.audio ? 'classic' : 'none'
	}

	get state(): Readonly<AtemState> | undefined {
		return this.#link?.state
	}

	/** The real ATEM ids behind a strip, for actions that the core doesn't do */
	where(id: string): Where | undefined {
		return this.#strips.get(id)?.where
	}

	// ---- connection ---------------------------------------------------------------

	start(host: DeviceHost): void {
		this.#host = host
		this.#stopped = false
		const addr = this.opts.host.trim()
		if (!addr) {
			this.#lastError = 'No ATEM address yet. Pop it in on the connection page.'
			host.disconnected(this.#lastError, false)
			return
		}
		const link = this.opts.makeLink()
		this.#link = link
		this.#lastError = `Looking for the ATEM at ${addr}…`
		this.#since = Date.now()
		this.#errTimer = setTimeout(() => this.#unreachable(), this.opts.unreachableMs ?? UNREACHABLE_MS)
		link.on('connected', () => this.#onConnected())
		link.on('disconnected', () => this.#onDisconnected())
		link.on('state', (_s, paths) => this.#onState(paths))
		link.on('levels', (l) => this.#onLevels(l))
		link.on('error', (m) => host.log('debug', `ATEM: ${m}`))
		link.on('info', (m) => host.log('debug', `ATEM: ${m}`))
		if (!link.classicLevels) host.log('debug', "Classic ATEM meters: couldn't hook into this version of atem-connection, so classic meters are off")
		link.connect(addr, this.opts.port || ATEM_PORT)
	}

	stop(): void {
		this.#stopped = true
		for (const t of [this.#publishTimer, this.#meterTimer, this.#durTimer]) if (t) clearInterval(t)
		if (this.#errTimer) clearTimeout(this.#errTimer)
		this.#publishTimer = this.#meterTimer = this.#durTimer = this.#errTimer = null
		const l = this.#link
		this.#link = null
		void l?.destroy()
	}

	#unreachable(): void {
		if (this.connected || this.#stopped) return
		const addr = this.opts.host.trim()
		this.#lastError = this.#everConnected
			? `Lost the ATEM at ${addr} (no answer for a few seconds). I'll keep trying.`
			: `Can't reach the ATEM at ${addr}. Is it on, is that the right address, and is this computer on the same network? ` +
				"If all that's fine, it may be out of control slots: close ATEM Software Control or another Companion connection to it and I'll get in."
		this.#host?.disconnected(this.#lastError, false)
	}

	#onConnected(): void {
		const host = this.#host
		const st = this.#link?.state
		if (!host || !st) return
		this.#everConnected = true
		if (this.#errTimer) clearTimeout(this.#errTimer)
		this.#errTimer = null
		this.#lastError = ''
		host.log('info', `Connected to ${st.info.productIdentifier || 'an ATEM'} (${this.mixer === 'fairlight' ? 'Fairlight audio' : this.mixer === 'classic' ? 'classic audio mixer' : 'no audio mixer'})`)
		if (this.mixer === 'none') {
			this.#lastError = "Connected, but this ATEM hasn't got an audio mixer I can drive."
			host.log('warn', this.#lastError)
		}
		this.#recActive = null
		host.version(protocolText(st.info.apiVersion))
		host.connected()
		// the ATEM forgets it was asked for levels every time we (re)connect
		this.#levelsAt = Date.now()
		this.#metersQuiet = false
		void this.#sendLevels(true)
		if (!this.#meterTimer) this.#meterTimer = setInterval(() => this.#flushMeters(), METER_MS)
		if (!this.#durTimer) this.#durTimer = setInterval(() => this.#pollDurations(), 1000)
	}

	#onDisconnected(): void {
		const was = this.#everConnected
		this.#strips.clear()
		this.#published = false
		this.#pendingMeters.clear()
		this.#lastError = `Lost the ATEM at ${this.opts.host.trim()}. I'll keep trying.`
		this.#host?.disconnected(this.#lastError, was)
		if (this.#errTimer) clearTimeout(this.#errTimer)
		this.#errTimer = setTimeout(() => this.#unreachable(), this.opts.unreachableMs ?? UNREACHABLE_MS)
	}

	async #sendLevels(on: boolean): Promise<void> {
		const m = this.mixer
		if (on) this.#levelsAskedAt = Date.now()
		try {
			if (m === 'fairlight') await this.#call(on ? 'startFairlightMixerSendLevels' : 'stopFairlightMixerSendLevels')
			else if (m === 'classic' && this.#link?.classicLevels) await this.#call('classicSendLevels', on)
		} catch (e) {
			this.#host?.log('debug', `Asking the ATEM for meters: ${(e as Error).message}`)
		}
	}

	async refresh(): Promise<void> {
		this.#publish(true)
	}

	// ---- the input list -------------------------------------------------------------

	/** Rebuild every strip from the ATEM's state */
	#build(): Strip[] {
		const st = this.#link?.state
		if (!st) return []
		if (st.fairlight) return this.#buildFairlight(st)
		if (st.audio) return this.#buildClassic(st)
		return []
	}

	#videoName(st: AtemState, audioId: number): string | undefined {
		if (audioId < 1000) return st.inputs[audioId]?.longName || undefined
		if (audioId > 2000 && audioId < 2051) return st.inputs[3000 + (audioId - 2000) * 10]?.longName || undefined
		return undefined
	}

	#label(st: AtemState, id: number, portType: number | undefined, xlrCount: number): string {
		const routed = st.fairlight?.audioRouting?.sources
		if (routed) for (const r of Object.values(routed)) if (r.audioSourceId === id && r.name) return r.name
		return audioInputLabel(id, portType, this.#videoName(st, id), xlrCount)
	}

	#buildFairlight(st: AtemState): Strip[] {
		const fl = st.fairlight!
		const out: Strip[] = []
		const ids = Object.keys(fl.inputs).map(Number).sort((a, b) => a - b)
		const xlr = ids.filter((i) => fl.inputs[i]?.properties?.externalPortType === PORT.XLR).length
		const solo = fl.solo
		const hasMonitor = !!fl.monitor
		for (const index of ids) {
			const input = fl.inputs[index]
			if (!input) continue
			const name = this.#label(st, index, input.properties?.externalPortType, xlr)
			const srcIds = Object.keys(input.sources).filter((s) => input.sources[s]?.properties)
			for (const source of srcIds) {
				const src = input.sources[source]!
				const p = src.properties!
				const split = source === SRC_CH1 || source === SRC_CH2
				const id = source === SRC_STEREO || srcIds.length === 1 ? `in${index}` : split ? `in${index}.${source === SRC_CH1 ? 1 : 2}` : `in${index}:${source}`
				const label = id === `in${index}` ? name : split ? `${name} ch ${source === SRC_CH1 ? 1 : 2}` : `${name} (${source})`
				const mixes = (p.supportedMixOptions?.length ? p.supportedMixOptions : [FL_MIX.on, FL_MIX.off]).map(flMixId)
				const bands = src.equalizer?.bands ?? []
				const caps: InputCaps = {
					fader: { minDb: -100, maxDb: 10 },
					trim: { minDb: -60, maxDb: 6, label: 'Trim' },
					mute: true,
					balance: true,
					mixOption: { label: 'Mix', choices: (['on', 'off', 'afv'] as MixId[]).filter((m) => mixes.includes(m)).map((m) => ({ id: m, label: MIX_LABELS[m] })) },
					processing: { kinds: [EQ_KIND, ...(bands.length ? [BAND_KIND] : []), EXPANDER_KIND, COMPRESSOR_KIND, LIMITER_KIND], addable: false },
					preMeter: true,
				}
				if (p.maxFramesDelay > 0) caps.delay = { unit: 'frames', min: 0, max: p.maxFramesDelay, step: 1, label: 'Delay' }
				if (hasMonitor) caps.monitor = SOLO_MONITOR
				const mix = flMixId(p.mixOption)
				const blocks: BlockInfo[] = [
					{ id: 'eq', name: 'EQ', kind: EQ_KIND, enabled: !!src.equalizer?.enabled, settings: { gain: (src.equalizer?.gain ?? 0) / 100 } },
					...bands.flatMap((b, i): BlockInfo[] =>
						b
							? [
									{
										id: bandId(i),
										name: `EQ band ${i + 1}`,
										kind: BAND_KIND,
										enabled: b.bandEnabled,
										settings: { shape: shapeId(b.shape), range: rangeId(b.frequencyRange), frequency: b.frequency, gain: b.gain / 100, q: b.qFactor / 100 },
									},
								]
							: [],
					),
					...this.#dynamicsBlocks(src.dynamics, true),
				]
				out.push({
					where: { t: 'fl', index, source },
					state: {
						id,
						name: label,
						kind: `fairlight:${input.properties?.inputType ?? ''}`,
						channels: p.sourceType === FL_SOURCE_MONO ? 1 : 2,
						caps,
						volumeDb: flToDb(p.faderGain),
						trimDb: flToDb(p.gain) ?? -100,
						hasTrim: true,
						muted: mix === 'off',
						balance: (p.balance / 100 + 100) / 200,
						delay: p.framesDelay ?? 0,
						monitor: hasMonitor ? (solo?.solo && solo.index === index && solo.source === source ? 'solo' : 'off') : '',
						routing: {},
						mixOption: mix,
						blocks,
					},
				})
			}
		}
		const m = fl.master
		if (m?.properties) {
			const bands = m.equalizer?.bands ?? []
			out.push({
				where: { t: 'flMaster' },
				state: {
					id: 'master',
					name: 'Master',
					kind: 'fairlight:master',
					channels: 2,
					caps: {
						fader: { minDb: -100, maxDb: 10 },
						mixOption: { label: 'Fade to black', choices: FTB_CHOICES },
						processing: { kinds: [EQ_KIND, ...(bands.length ? [BAND_KIND] : []), COMPRESSOR_KIND, LIMITER_KIND], addable: false },
						preMeter: true,
						role: 'master',
					},
					volumeDb: flToDb(m.properties.faderGain),
					trimDb: 0,
					hasTrim: false,
					muted: false,
					balance: 0.5,
					delay: 0,
					monitor: '',
					routing: {},
					mixOption: m.properties.followFadeToBlack ? 'ftb' : 'free',
					blocks: [
						{ id: 'eq', name: 'EQ', kind: EQ_KIND, enabled: !!m.equalizer?.enabled, settings: { gain: (m.equalizer?.gain ?? 0) / 100 } },
						...bands.flatMap((b, i): BlockInfo[] =>
							b
								? [
										{
											id: bandId(i),
											name: `EQ band ${i + 1}`,
											kind: BAND_KIND,
											enabled: b.bandEnabled,
											settings: { shape: shapeId(b.shape), range: rangeId(b.frequencyRange), frequency: b.frequency, gain: b.gain / 100, q: b.qFactor / 100 },
										},
									]
								: [],
						),
						...this.#dynamicsBlocks(m.dynamics, false),
					],
				},
			})
		}
		const mon = fl.monitor
		if (mon) {
			const split = SPLIT_MONITOR_MODELS.has(st.info.model)
			out.push(this.#bus('monitor', 'Headphones', { t: 'flMonitor', part: 'gain' }, flToDb(mon.gain), -100, 6, undefined, 'monitor'))
			if (split) {
				out.push(this.#bus('phones_prog', 'Headphones: programme', { t: 'flMonitor', part: 'prog' }, flToDb(mon.inputMasterGain), -60, 6, mon.inputMasterMuted, 'monitor'))
				out.push(this.#bus('talkback', 'Talkback', { t: 'flMonitor', part: 'talkback' }, flToDb(mon.inputTalkbackGain), -60, 0, mon.inputTalkbackMuted, 'talkback'))
				out.push(this.#bus('sidetone', 'Sidetone', { t: 'flMonitor', part: 'sidetone' }, flToDb(mon.inputSidetoneGain), -60, 6, undefined, 'monitor'))
			}
		}
		return out
	}

	#dynamicsBlocks(d: Fairlight.FairlightAudioDynamicsState | undefined, expander: boolean): BlockInfo[] {
		const out: BlockInfo[] = []
		const t = (n: number | undefined) => (n ?? 0) / 100
		if (expander && d?.expander) {
			const e = d.expander
			out.push({
				id: 'expander',
				name: e.gateEnabled ? 'Gate' : 'Expander',
				kind: EXPANDER_KIND,
				enabled: e.expanderEnabled,
				settings: { gate: e.gateEnabled ? 'gate' : 'expander', threshold: t(e.threshold), range: t(e.range), ratio: t(e.ratio), attack: t(e.attack), hold: t(e.hold), release: t(e.release) },
			})
		}
		if (d?.compressor) {
			const c = d.compressor
			out.push({
				id: 'compressor',
				name: 'Compressor',
				kind: COMPRESSOR_KIND,
				enabled: c.compressorEnabled,
				settings: { threshold: t(c.threshold), ratio: t(c.ratio), attack: t(c.attack), hold: t(c.hold), release: t(c.release), makeUp: t(d.makeUpGain) },
			})
		}
		if (d?.limiter) {
			const l = d.limiter
			out.push({ id: 'limiter', name: 'Limiter', kind: LIMITER_KIND, enabled: l.limiterEnabled, settings: { threshold: t(l.threshold), attack: t(l.attack), hold: t(l.hold), release: t(l.release) } })
		}
		return out
	}

	/** A bus strip: just a level (and maybe a mute) */
	#bus(id: string, name: string, where: Where, db: Db, minDb: number, maxDb: number, muted: boolean | undefined, role: 'master' | 'monitor' | 'talkback'): Strip {
		return {
			where,
			state: {
				id,
				name,
				kind: `bus:${id}`,
				channels: 2,
				caps: { fader: { minDb, maxDb }, ...(muted === undefined ? {} : { mute: true }), role },
				volumeDb: db,
				trimDb: 0,
				hasTrim: false,
				muted: !!muted,
				balance: 0.5,
				delay: 0,
				monitor: '',
				routing: {},
				mixOption: '',
				blocks: [],
			},
		}
	}

	#classicGain(id: string, db: number): Db {
		const v: Db = Number.isFinite(db) ? db : null
		const sent = this.#sentClassic.get(id)
		// the ATEM stores gain as a 16-bit number, so what comes back can be a hair off what we sent
		if (sent && Date.now() - sent.at < 2000 && (sent.db === v || (sent.db !== null && v !== null && Math.abs(sent.db - v) < 0.3))) return sent.db
		return v === null || v <= -100 ? null : Math.round(v * 100) / 100
	}

	#buildClassic(st: AtemState): Strip[] {
		const a = st.audio!
		const out: Strip[] = []
		const ids = Object.keys(a.channels).map(Number).sort((x, y) => x - y)
		const xlr = ids.filter((i) => a.channels[i]?.portType === PORT.XLR).length
		const mon = a.monitor
		const hasMonitor = !!a.hasMonitor && !!mon
		for (const index of ids) {
			const c = a.channels[index]
			if (!c) continue
			const id = `in${index}`
			const mix = clMixId(c.mixOption)
			out.push({
				where: { t: 'cl', index },
				state: {
					id,
					name: audioInputLabel(index, c.portType, this.#videoName(st, index), xlr),
					kind: `classic:${c.sourceType}`,
					channels: 2,
					caps: {
						fader: { minDb: -100, maxDb: 6 },
						mute: true,
						balance: true,
						mixOption: { label: 'Mix', choices: (['on', 'off', 'afv'] as MixId[]).map((m) => ({ id: m, label: MIX_LABELS[m] })) },
						...(hasMonitor ? { monitor: SOLO_MONITOR } : {}),
					},
					volumeDb: this.#classicGain(id, c.gain),
					trimDb: 0,
					hasTrim: false,
					muted: mix === 'off',
					balance: (Math.max(-50, Math.min(50, c.balance)) + 50) / 100,
					delay: 0,
					monitor: hasMonitor ? (mon!.solo && mon!.soloSource === index ? 'solo' : 'off') : '',
					routing: {},
					mixOption: mix,
					blocks: [],
				},
			})
		}
		if (a.master) {
			out.push({
				where: { t: 'clMaster' },
				state: {
					id: 'master',
					name: 'Master',
					kind: 'classic:master',
					channels: 2,
					caps: { fader: { minDb: -100, maxDb: 6 }, balance: true, mixOption: { label: 'Fade to black', choices: FTB_CHOICES }, role: 'master' },
					volumeDb: this.#classicGain('master', a.master.gain),
					trimDb: 0,
					hasTrim: false,
					muted: false,
					balance: (Math.max(-50, Math.min(50, a.master.balance)) + 50) / 100,
					delay: 0,
					monitor: '',
					routing: {},
					mixOption: a.master.followFadeToBlack ? 'ftb' : 'free',
					blocks: [],
				},
			})
		}
		if (hasMonitor) out.push(this.#bus('monitor', 'Monitor', { t: 'clMonitor' }, this.#classicGain('monitor', mon!.gain), -100, 6, mon!.mute, 'monitor'))
		const h = a.headphones
		if (h) {
			out.push(this.#bus('phones', 'Headphones', { t: 'clPhones', part: 'gain' }, this.#classicGain('phones', h.gain), -60, 6, undefined, 'monitor'))
			out.push(this.#bus('phones_prog', 'Headphones: programme', { t: 'clPhones', part: 'prog' }, this.#classicGain('phones_prog', h.programOutGain), -60, 6, undefined, 'monitor'))
			out.push(this.#bus('talkback', 'Talkback', { t: 'clPhones', part: 'talkback' }, this.#classicGain('talkback', h.talkbackGain), -60, 6, undefined, 'talkback'))
			out.push(this.#bus('sidetone', 'Sidetone', { t: 'clPhones', part: 'sidetone' }, this.#classicGain('sidetone', h.sidetoneGain), -60, 6, undefined, 'monitor'))
		}
		return out
	}

	/** Compare the rebuilt list with the last one and tell the core what changed */
	#publish(full = false): void {
		const host = this.#host
		if (!host || !this.connected) return
		const list = this.#build()
		const ids = list.map((s) => s.state.id)
		const capsChanged = list.some((s) => {
			const old = this.#strips.get(s.state.id)
			return !old || JSON.stringify(old.state.caps) !== JSON.stringify(s.state.caps) || old.state.channels !== s.state.channels
		})
		const sameSet = ids.length === this.#order.length && ids.every((id, i) => this.#order[i] === id)
		const old = this.#strips
		this.#strips = new Map(list.map((s) => [s.state.id, s]))
		this.#order = ids
		if (full || !this.#published || !sameSet || capsChanged) {
			this.#published = true
			host.inputs(list.map((s) => structuredClone(s.state)))
			return
		}
		for (const s of list) {
			const o = old.get(s.state.id)!.state
			const n = s.state
			if (o.name !== n.name) host.inputRenamed(n.id, n.id, n.name)
			const patch: Partial<DeviceInputState> = {}
			for (const k of ['volumeDb', 'trimDb', 'muted', 'balance', 'delay', 'monitor', 'mixOption'] as const) {
				if (o[k] !== n[k]) (patch as Record<string, unknown>)[k] = n[k]
			}
			const blocksChanged = JSON.stringify(o.blocks) !== JSON.stringify(n.blocks)
			if (blocksChanged) {
				patch.blocks = structuredClone(n.blocks)
				// the expander's name follows its mode
				const names = (b: BlockInfo[]) => b.map((x) => x.id + x.name).join()
				if (names(o.blocks) !== names(n.blocks)) {
					host.inputChanged(n.id, patch, true)
					continue
				}
			}
			if (Object.keys(patch).length) host.inputChanged(n.id, patch)
		}
	}

	#onState(paths: string[]): void {
		if (paths.some((p) => p.startsWith('recording') || p.startsWith('streaming'))) this.#onRecordState()
		const relevant = paths.some((p) => p.startsWith('fairlight') || p.startsWith('audio') || p.startsWith('inputs'))
		if (!relevant || this.#publishTimer) return
		// bursts of changes (a fade, a big state update) are sent as one
		this.#publishTimer = setTimeout(() => {
			this.#publishTimer = null
			this.#publish()
		}, 10)
	}

	// ---- meters -------------------------------------------------------------------------

	#onLevels(l: unknown): void {
		this.#levelsAt = Date.now()
		if (this.#metersQuiet) {
			this.#metersQuiet = false
			this.#host?.log('info', 'ATEM meters are back.')
		}
		const lv = l as { system?: string; type?: string; index?: number; source?: unknown; levels?: Record<string, number> }
		const st = this.#mstat
		if (lv.system === 'classic') st.classic++
		else if (lv.type === 'master') st.master++
		else st.src++
		if (lv.system === 'fairlight' && lv.levels && (st.last === '' || lv.type === 'source')) st.last = `${lv.type} ${lv.index ?? ''}/${String(lv.source ?? '')} L ${lv.levels.leftLevel} pk ${lv.levels.leftPeak}`
		if (lv.system === 'classic') return this.#onClassicLevels(l as ClassicLevels)
		if (lv.system !== 'fairlight') return
		const f = l as { type: 'source' | 'master'; index?: number; source?: bigint; levels: Record<string, number> }
		let id: string | undefined
		if (f.type === 'master') id = 'master'
		else {
			const src = String(f.source)
			for (const [sid, s] of this.#strips) if (s.where.t === 'fl' && s.where.index === f.index && s.where.source === src) id = sid
		}
		const s = id ? this.#strips.get(id) : undefined
		if (!s || !id) {
			st.unmatched++
			return
		}
		const v = f.levels
		const mono = s.state.channels === 1
		const pair = (a: string, b: string) => (mono ? [Math.max(flLevelToMul(v[a]), flLevelToMul(v[b]))] : [flLevelToMul(v[a]), flLevelToMul(v[b])])
		const gr: Record<string, number> = { compressor: flGainReduction(v.compressorGainReduction), limiter: flGainReduction(v.limiterGainReduction) }
		if (f.type === 'source') gr.expander = flGainReduction(v.expanderGainReduction)
		this.#pendingMeters.set(id, {
			id,
			postMag: pair('leftLevel', 'rightLevel'),
			postPeak: pair('leftPeak', 'rightPeak'),
			// after the trim, EQ and dynamics, before the fader (like OBS's "after the filters")
			prePeak: pair('outputLeftPeak', 'outputRightPeak'),
			gainReduction: gr,
		})
	}

	#onClassicLevels(l: ClassicLevels): void {
		const put = (id: string, m: ClassicLevels['master']) => {
			if (!this.#strips.has(id)) return
			this.#pendingMeters.set(id, { id, postMag: [m.left, m.right], postPeak: [m.leftPeak, m.rightPeak], prePeak: [] })
		}
		for (const i of l.inputs) put(`in${i.id}`, i.levels)
		put('master', l.master)
		put('monitor', l.monitor)
	}

	/** The ATEM can stop sending meters on its own: if they go quiet, ask again (and say so once) */
	#checkMetersAlive(): void {
		if (!this.connected || this.mixer === 'none') return
		const quiet = this.opts.metersQuietMs ?? METERS_QUIET_MS
		const now = Date.now()
		if (now - this.#levelsAt < quiet || now - this.#levelsAskedAt < quiet) return
		if (!this.#metersQuiet) {
			this.#metersQuiet = true
			this.#host?.log('info', `ATEM meters went quiet for ${(quiet / 1000).toFixed(1)} s. Asking for them again (and again, until they're back).`)
		}
		// off then on, in case the ATEM ignores "on" when it thinks it's already on
		this.#levelsAskedAt = now
		void this.#sendLevels(false).then(() => this.#sendLevels(true))
	}

	#meterStats(): void {
		const st = this.#mstat
		const now = Date.now()
		if (now - st.at < 10000) return
		this.#host?.log('debug', `Meters, last ${((now - st.at) / 1000).toFixed(0)} s: ${st.src} source, ${st.master} master, ${st.classic} classic, ${st.unmatched} not matched to a strip, ${this.#strips.size} strips. Latest: ${st.last || 'none'}`)
		this.#mstat = { src: 0, master: 0, classic: 0, unmatched: 0, at: now, last: '' }
	}

	#flushMeters(): void {
		this.#checkMetersAlive()
		this.#meterStats()
		if (!this.#pendingMeters.size) return
		const list = [...this.#pendingMeters.values()]
		this.#pendingMeters.clear()
		this.#host?.meters(list)
	}

	// ---- sending ----------------------------------------------------------------------

	#call<K extends keyof AtemCalls>(method: K, ...args: AtemCalls[K]): Promise<void> {
		const l = this.#link
		if (!l?.connected) return Promise.reject(new Error('Not connected to the ATEM'))
		return l.call(method, ...args)
	}

	#strip(id: string): Strip {
		const s = this.#strips.get(id)
		if (!s) throw new Error(`The ATEM hasn't got an input "${id}" (any more)`)
		return s
	}

	/** A Fairlight source, checked it's still there (the ATEM quietly ignores commands to missing ones) */
	#fl(id: string): { index: number; source: string } {
		const w = this.#strip(id).where
		if (w.t !== 'fl') throw new Error(`${id} isn't a Fairlight input`)
		if (!this.#link?.state?.fairlight?.inputs[w.index]?.sources[w.source]) throw new Error(`The ATEM's input ${id} isn't there any more (was it switched between stereo and dual mono?)`)
		return w
	}

	async setVolume(id: string, db: Db): Promise<void> {
		const w = this.#strip(id).where
		const caps = this.#strip(id).state.caps.fader
		switch (w.t) {
			case 'fl':
				this.#fl(id)
				return this.#call('setFairlightAudioMixerSourceProps', w.index, w.source, { faderGain: dbToFl(db, caps.minDb, caps.maxDb) })
			case 'flMaster':
				return this.#call('setFairlightAudioMixerMasterProps', { faderGain: dbToFl(db, caps.minDb, caps.maxDb) })
			case 'flMonitor': {
				const v = dbToFl(db, caps.minDb, caps.maxDb)
				const key = { gain: 'gain', prog: 'inputMasterGain', talkback: 'inputTalkbackGain', sidetone: 'inputSidetoneGain' }[w.part]
				return this.#call('setFairlightAudioMixerMonitorProps', { [key]: Math.max(v, caps.minDb * 100) })
			}
			default: {
				const v = db === null ? -Infinity : Math.min(caps.maxDb, db)
				this.#sentClassic.set(id, { db: db === null ? null : v, at: Date.now() })
				if (w.t === 'cl') return this.#call('setClassicAudioMixerInputProps', w.index, { gain: v })
				if (w.t === 'clMaster') return this.#call('setClassicAudioMixerMasterProps', { gain: v })
				if (w.t === 'clMonitor') return this.#call('setClassicAudioMixerMonitorProps', { gain: v })
				const key = { gain: 'gain', prog: 'programOutGain', talkback: 'talkbackGain', sidetone: 'sidetoneGain' }[w.part]
				return this.#call('setClassicAudioMixerHeadphonesProps', { [key]: v })
			}
		}
	}

	async setTrim(id: string, db: number): Promise<void> {
		const w = this.#fl(id)
		return this.#call('setFairlightAudioMixerSourceProps', w.index, w.source, { gain: dbToFl(db, -100, 6) })
	}

	async setBalance(id: string, balance: number): Promise<void> {
		const w = this.#strip(id).where
		const b = Math.max(0, Math.min(1, balance))
		if (w.t === 'fl') {
			this.#fl(id)
			return this.#call('setFairlightAudioMixerSourceProps', w.index, w.source, { balance: Math.round((b * 200 - 100) * 100) })
		}
		if (w.t === 'cl') return this.#call('setClassicAudioMixerInputProps', w.index, { balance: b * 100 - 50 })
		if (w.t === 'clMaster') return this.#call('setClassicAudioMixerMasterProps', { balance: b * 100 - 50 })
		throw new Error(`${id} has no balance`)
	}

	async setDelay(id: string, frames: number): Promise<void> {
		const w = this.#fl(id)
		const max = this.#strip(id).state.caps.delay?.max ?? 0
		return this.#call('setFairlightAudioMixerSourceProps', w.index, w.source, { framesDelay: Math.max(0, Math.min(max, Math.round(frames))) })
	}

	async setMixOption(id: string, value: string): Promise<void> {
		const s = this.#strip(id)
		const w = s.where
		if (w.t === 'flMaster') return this.#call('setFairlightAudioMixerMasterProps', { followFadeToBlack: value === 'ftb' })
		if (w.t === 'clMaster') return this.#call('setClassicAudioMixerMasterProps', { followFadeToBlack: value === 'ftb' })
		if (!s.state.caps.mixOption?.choices.some((c) => c.id === value)) throw new Error(`"${value}" isn't a mix option ${s.state.name} has`)
		const m = value as MixId
		if (w.t === 'fl') {
			this.#fl(id)
			return this.#call('setFairlightAudioMixerSourceProps', w.index, w.source, { mixOption: FL_MIX[m] })
		}
		if (w.t === 'cl') return this.#call('setClassicAudioMixerInputProps', w.index, { mixOption: CL_MIX[m] })
		throw new Error(`${id} has no mix option`)
	}

	/** Mute = the ATEM's "off"; unmute puts back what it was (on, or AFV) */
	async setMute(id: string, muted: boolean): Promise<void> {
		const s = this.#strip(id)
		const w = s.where
		if (w.t === 'flMonitor') {
			if (w.part === 'prog') return this.#call('setFairlightAudioMixerMonitorProps', { inputMasterMuted: muted })
			if (w.part === 'talkback') return this.#call('setFairlightAudioMixerMonitorProps', { inputTalkbackMuted: muted })
			throw new Error(`${s.state.name} has no mute`)
		}
		if (w.t === 'clMonitor') return this.#call('setClassicAudioMixerMonitorProps', { mute: muted })
		if (w.t !== 'fl' && w.t !== 'cl') throw new Error(`${s.state.name} has no mute`)
		const cur = s.state.mixOption as MixId
		if (muted) {
			if (cur !== 'off') this.#beforeMute.set(id, cur)
			return this.setMixOption(id, 'off')
		}
		if (cur !== 'off') return
		const back = this.#beforeMute.get(id) ?? 'on'
		this.#beforeMute.delete(id)
		return this.setMixOption(id, s.state.caps.mixOption?.choices.some((c) => c.id === back) ? back : 'on')
	}

	/** Which strip the ATEM is soloing, going by what we last asked for if that was just now */
	#soloNow(): string | null {
		if (this.#soloWant && Date.now() - this.#soloWant.at < 1500) return this.#soloWant.id
		for (const [id, s] of this.#strips) if (s.state.monitor === 'solo') return id
		return null
	}

	/** Monitoring = the ATEM's solo (one source at a time: soloing another swaps over) */
	async setMonitor(id: string, value: string): Promise<void> {
		const w = this.#strip(id).where
		if (w.t !== 'fl' && w.t !== 'cl') throw new Error(`${id} can't be soloed`)
		if (w.t === 'fl') this.#fl(id)
		if (value === 'solo') {
			this.#soloWant = { id, at: Date.now() }
			if (w.t === 'fl') return this.#call('setFairlightAudioMixerMonitorSolo', { solo: true, index: w.index, source: w.source })
			return this.#call('setClassicAudioMixerMonitorProps', { solo: true, soloSource: w.index })
		}
		// off: only if it's this one being soloed (otherwise it's already off)
		if (this.#soloNow() !== id) return
		this.#soloWant = { id: null, at: Date.now() }
		if (w.t === 'fl') return this.#call('setFairlightAudioMixerMonitorSolo', { solo: false })
		return this.#call('setClassicAudioMixerMonitorProps', { solo: false })
	}

	async setBlockEnabled(id: string, blockId: string, on: boolean): Promise<void> {
		const w = this.#strip(id).where
		const master = w.t === 'flMaster'
		const src = master ? undefined : this.#fl(id)
		const b = bandIndex(blockId)
		if (blockId === 'eq') return master ? this.#call('setFairlightAudioMixerMasterProps', { equalizerEnabled: on }) : this.#call('setFairlightAudioMixerSourceProps', src!.index, src!.source, { equalizerEnabled: on })
		if (b >= 0 && b < BAND_COUNT)
			return master ? this.#call('setFairlightAudioMixerMasterEqualizerBandProps', b, { bandEnabled: on }) : this.#call('setFairlightAudioMixerSourceEqualizerBandProps', src!.index, src!.source, b, { bandEnabled: on })
		if (blockId === 'expander' && !master) return this.#call('setFairlightAudioMixerSourceExpanderProps', src!.index, src!.source, { expanderEnabled: on })
		if (blockId === 'compressor')
			return master ? this.#call('setFairlightAudioMixerMasterCompressorProps', { compressorEnabled: on }) : this.#call('setFairlightAudioMixerSourceCompressorProps', src!.index, src!.source, { compressorEnabled: on })
		if (blockId === 'limiter')
			return master ? this.#call('setFairlightAudioMixerMasterLimiterProps', { limiterEnabled: on }) : this.#call('setFairlightAudioMixerSourceLimiterProps', src!.index, src!.source, { limiterEnabled: on })
		throw new Error(`${id} has no "${blockId}"`)
	}

	async setBlockParam(id: string, blockId: string, key: string, value: unknown): Promise<void> {
		const s = this.#strip(id)
		const block = s.state.blocks.find((b) => b.id === blockId)
		if (!block) throw new Error(`${s.state.name} has no "${blockId}"`)
		const v = checkParam(block.kind, key, value)
		if (v === undefined) throw new Error(`"${String(value)}" won't do for ${block.name} ${key}`)
		const raw = toAtem(key, v)
		const field = atemKey(block.kind, key)
		const master = s.where.t === 'flMaster'
		const src = master ? undefined : this.#fl(id)
		const b = bandIndex(blockId)
		if (blockId === 'eq') return master ? this.#call('setFairlightAudioMixerMasterProps', { equalizerGain: raw as number }) : this.#call('setFairlightAudioMixerSourceProps', src!.index, src!.source, { equalizerGain: raw as number })
		if (b >= 0) return master ? this.#call('setFairlightAudioMixerMasterEqualizerBandProps', b, { [field]: raw }) : this.#call('setFairlightAudioMixerSourceEqualizerBandProps', src!.index, src!.source, b, { [field]: raw })
		if (key === 'makeUp') return master ? this.#call('setFairlightAudioMixerMasterProps', { makeUpGain: raw as number }) : this.#call('setFairlightAudioMixerSourceProps', src!.index, src!.source, { makeUpGain: raw as number })
		if (blockId === 'expander' && !master) return this.#call('setFairlightAudioMixerSourceExpanderProps', src!.index, src!.source, { [field]: raw })
		if (blockId === 'compressor') return master ? this.#call('setFairlightAudioMixerMasterCompressorProps', { [field]: raw }) : this.#call('setFairlightAudioMixerSourceCompressorProps', src!.index, src!.source, { [field]: raw })
		if (blockId === 'limiter') return master ? this.#call('setFairlightAudioMixerMasterLimiterProps', { [field]: raw }) : this.#call('setFairlightAudioMixerSourceLimiterProps', src!.index, src!.source, { [field]: raw })
		throw new Error(`${s.state.name} has no "${blockId}"`)
	}

	// ---- ATEM extras (for Companion actions the core doesn't have) -------------------

	/** Reset an EQ or dynamics block (or all of them) on an input or the master */
	async reset(id: string, what: 'eq' | 'dynamics' | 'peaks'): Promise<void> {
		const s = this.#strip(id)
		const w = s.where
		if (what === 'peaks') {
			if (w.t === 'fl') return this.#call('setFairlightAudioMixerSourceResetPeaks', w.index, w.source, { output: true, dynamicsInput: true, dynamicsOutput: true })
			if (w.t === 'flMaster') return this.#call('setFairlightAudioMixerResetPeaks', { all: false, master: true })
			if (w.t === 'cl') return this.#call('setClassicAudioResetPeaks', { input: w.index })
			if (w.t === 'clMaster') return this.#call('setClassicAudioResetPeaks', { master: true })
			if (w.t === 'clMonitor') return this.#call('setClassicAudioResetPeaks', { monitor: true })
			throw new Error(`${s.state.name} has no peak meters to reset`)
		}
		if (w.t === 'flMaster') {
			if (what === 'eq') return this.#call('setFairlightAudioMixerMasterEqualizerReset', { equalizer: true })
			return this.#call('setFairlightAudioMixerMasterDynamicsReset', { dynamics: true })
		}
		const src = this.#fl(id)
		if (what === 'eq') return this.#call('setFairlightAudioMixerSourceEqualizerReset', src.index, src.source, { equalizer: true })
		return this.#call('setFairlightAudioMixerSourceDynamicsReset', src.index, src.source, { dynamics: true })
	}

	async resetAllPeaks(): Promise<void> {
		if (this.mixer === 'fairlight') return this.#call('setFairlightAudioMixerResetPeaks', { all: true, master: true })
		if (this.mixer === 'classic') return this.#call('setClassicAudioResetPeaks', { all: true })
	}

	/** A Fairlight input's channel layout: stereo, or split into two mono channels */
	async setInputConfig(id: string, config: 'mono' | 'stereo' | 'dualmono'): Promise<void> {
		const w = this.#strip(id).where
		if (w.t !== 'fl') throw new Error(`${id} isn't a Fairlight input`)
		const p = this.#link?.state?.fairlight?.inputs[w.index]?.properties
		const v = { mono: 1, stereo: 2, dualmono: 4 }[config]
		if (p && !p.supportedConfigurations.includes(v)) throw new Error(`${id} can't be ${config === 'dualmono' ? 'dual mono' : config}`)
		return this.#call('setFairlightAudioMixerInputProps', w.index, { activeConfiguration: v })
	}

	/** A Fairlight analog input's level: mic, consumer line or pro line */
	async setInputLevel(id: string, level: 'mic' | 'line' | 'proline'): Promise<void> {
		const w = this.#strip(id).where
		if (w.t !== 'fl') throw new Error(`${id} isn't a Fairlight input`)
		const p = this.#link?.state?.fairlight?.inputs[w.index]?.properties
		const v = { mic: 1, line: 2, proline: 4 }[level]
		if (p && !p.supportedInputLevels.includes(v)) throw new Error(`${id} can't be set to ${level}`)
		// the library's type leaves this out, but its V8 command sends it (api 8.0 or later)
		return this.#call('setFairlightAudioMixerInputProps', w.index, { activeInputLevel: v } as unknown as AtemCalls['setFairlightAudioMixerInputProps'][1])
	}

	/** The whole mixer's audio-follow-video crossfade */
	async setAfvCrossfade(on: boolean): Promise<void> {
		if (this.mixer === 'fairlight') return this.#call('setFairlightAudioFollowVideoCrossfade', on)
		if (this.mixer === 'classic') return this.#call('setClassicAudioMixerProps', { audioFollowVideo: on })
		throw new Error('This ATEM has no audio mixer')
	}

	/** Classic monitor dim */
	async setDim(on: boolean): Promise<void> {
		if (!this.#link?.state?.audio?.monitor) throw new Error('This ATEM has no classic monitor out to dim')
		return this.#call('setClassicAudioMixerMonitorProps', { dim: on })
	}

	async setStreaming(on: boolean): Promise<void> {
		if (!this.#link?.state?.streaming) throw new Error("This ATEM doesn't stream (or its software is too old for me to drive it)")
		return this.#call(on ? 'startStreaming' : 'stopStreaming')
	}

	async setIso(on: boolean): Promise<void> {
		if (this.#link?.state?.recording?.recordAllInputs === undefined) throw new Error("This ATEM doesn't do ISO recording")
		return this.#call('setEnableISORecording', on)
	}

	async switchDisk(): Promise<void> {
		if (!this.#link?.state?.recording) throw new Error("This ATEM doesn't record")
		return this.#call('switchRecordingDisk')
	}

	extras(): AtemExtras {
		const st = this.#link?.state
		const tc = (d: { hours: number; minutes: number; seconds: number } | undefined) =>
			d ? `${String(d.hours).padStart(2, '0')}:${String(d.minutes).padStart(2, '0')}:${String(d.seconds).padStart(2, '0')}` : ''
		const r = st?.recording
		const sm = st?.streaming
		let disk = ''
		if (r) {
			const d = Object.values(r.disks ?? {}).find((x) => x && x.status & (DISK_STATUS.Active | DISK_STATUS.Recording))
			disk = d?.volumeName ?? ''
		}
		const rs = r?.status?.state
		const ss = sm?.status?.state
		return {
			mixer: this.mixer,
			model: st?.info.productIdentifier ?? '',
			protocol: protocolText(st?.info.apiVersion),
			afvCrossfade: st?.fairlight?.audioFollowVideoCrossfadeTransitionEnabled ?? st?.audio?.audioFollowVideoCrossfadeTransitionEnabled ?? null,
			recording: r
				? {
						state: rs === REC_STATUS.Stopping ? 'stopping' : rs !== undefined && rs & REC_STATUS.Recording ? 'recording' : 'idle',
						error: REC_ERROR[r.status?.error ?? 2] ?? '',
						secondsLeft: r.status && r.status.recordingTimeAvailable >= 0 ? r.status.recordingTimeAvailable : null,
						disk,
						fileName: r.properties?.filename ?? '',
						iso: r.recordAllInputs ?? null,
						duration: tc(r.duration),
					}
				: null,
			streaming: sm
				? {
						state: ss === STREAM_STATUS.Stopping ? 'stopping' : ss === STREAM_STATUS.Streaming ? 'streaming' : ss === STREAM_STATUS.Connecting ? 'connecting' : 'idle',
						duration: tc(sm.duration),
						bitrate: sm.stats?.encodingBitrate ?? null,
					}
				: null,
			ftp: !!st && FTP_MODELS.has(st.info.model),
		}
	}

	// ---- recording ------------------------------------------------------------------

	#recActiveNow(): boolean {
		const s = this.#link?.state?.recording?.status?.state
		return s !== undefined && (s === REC_STATUS.Stopping || (s & REC_STATUS.Recording) !== 0)
	}

	#onRecordState(): void {
		const active = this.#recActiveNow()
		const edge = this.#recActive !== null && this.#recActive !== active
		this.#recActive = active
		this.#host?.record({ active, paused: false, edge })
	}

	#pollDurations(): void {
		const st = this.#link?.state
		if (!this.connected || !st) return
		if (st.recording && this.#recActiveNow()) void this.#call('requestRecordingDuration').catch(() => undefined)
		if (st.streaming?.status?.state === STREAM_STATUS.Streaming) void this.#call('requestStreamingDuration').catch(() => undefined)
	}

	/** Recording, when this ATEM records (protocol 8.1.1 or later, a model with a disk) */
	get recording(): DeviceRecording | undefined {
		if (!this.#link?.state?.recording) return undefined
		return {
			status: async () => ({ active: this.#recActiveNow(), paused: false, timecode: this.extras().recording?.duration ?? '' }),
			details: async () => ({ directory: this.opts.recordingsFolder || undefined, fileName: this.#link?.state?.recording?.properties?.filename ?? '' }),
			start: () => this.#call('startRecording'),
			stop: () => this.#call('stopRecording'),
			setFileName: (name: string) => this.#call('setRecordingSettings', { filename: trimBytes(name, 128) }),
		}
	}
}

/** Cut text to at most n bytes of UTF-8, without splitting a character */
export function trimBytes(text: string, n: number): string {
	let out = ''
	let bytes = 0
	for (const ch of text) {
		const b = Buffer.byteLength(ch)
		if (bytes + b > n) break
		out += ch
		bytes += b
	}
	return out
}
