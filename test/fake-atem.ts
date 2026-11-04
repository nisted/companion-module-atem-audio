/**
 * A pretend ATEM for tests: implements our AtemLink (src/atem-link.ts), so
 * nothing touches the network or the library. It holds an AtemState built by
 * hand in the shapes atem-connection 3.10.3 uses, records every call, echoes
 * setters back into its state (like the real thing does), and sends meters
 * at 20 Hz from a synthetic signal per source.
 *
 * Fairlight levels go out the way the library hands them over (dB×100);
 * classic levels go through our own AMLv encoder and parser, as on the wire.
 */
import { EventEmitter } from 'node:events'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { AtemState } from 'atem-connection'
import type { AtemCalls, AtemLink, AtemLinkEvents } from '../src/atem-link.js'
import { encodeClassicLevels, parseClassicLevels, type ClassicMeter } from '../src/classic-levels.js'
import { MODEL, SRC_CH1, SRC_CH2, SRC_STEREO } from '../src/atem-values.js'

type Any = Record<string, any>

const band = (i: number) => ({
	bandEnabled: i === 0 || i === 5,
	supportedShapes: [1, 2, 4, 8, 16, 32],
	shape: i === 0 ? 16 : i === 5 ? 32 : 4,
	supportedFrequencyRanges: [1, 2, 4, 8],
	frequencyRange: [1, 2, 2, 4, 8, 8][i],
	frequency: [80, 250, 1000, 3000, 8000, 12000][i],
	gain: 0,
	qFactor: 70,
})

function flSource(over: Any = {}): Any {
	return {
		properties: {
			sourceType: 1,
			maxFramesDelay: 0,
			framesDelay: 0,
			hasStereoSimulation: false,
			stereoSimulation: 0,
			gain: 0,
			balance: 0,
			faderGain: 0,
			supportedMixOptions: [1, 2, 4],
			mixOption: 2,
			...over,
		},
		equalizer: { enabled: false, gain: 0, bands: [0, 1, 2, 3, 4, 5].map(band) },
		dynamics: {
			makeUpGain: 0,
			expander: { expanderEnabled: false, gateEnabled: false, threshold: -4500, range: 1800, ratio: 110, attack: 140, hold: 0, release: 9300 },
			compressor: { compressorEnabled: true, threshold: -3500, ratio: 200, attack: 140, hold: 0, release: 9300 },
			limiter: { limiterEnabled: false, threshold: -1200, attack: 70, hold: 0, release: 9300 },
		},
	}
}

function baseState(model: number, product: string): Any {
	return {
		info: { apiVersion: 0x00020020, model, productIdentifier: product, superSources: [], mixEffects: [], power: [], capabilities: { talkbackChannels: 0 } },
		video: { mixEffects: [], downstreamKeyers: [], auxilliaries: [], superSources: [] },
		media: { stillPool: [], clipPool: [], players: [] },
		inputs: {
			1: { inputId: 1, longName: 'Presenter cam', shortName: 'CAM1' },
			2: { inputId: 2, longName: 'Laptop', shortName: 'LAP' },
			3: { inputId: 3, longName: 'Wide', shortName: 'WIDE' },
		},
		macro: {},
		settings: { multiViewers: [], videoMode: 0 },
	}
}

/** A Fairlight ATEM Mini Extreme ISO: HDMI 1-3, a dual-mono mic jack (two sources), master, headphones */
export function fairlightState(): AtemState {
	const s = baseState(MODEL.MiniExtremeISO, 'ATEM Mini Extreme ISO')
	s.fairlight = {
		inputs: {
			1: { properties: { inputType: 0, externalPortType: 2, supportedConfigurations: [2], activeConfiguration: 2, supportedInputLevels: [], activeInputLevel: 0 }, sources: { [SRC_STEREO]: flSource() } },
			2: { properties: { inputType: 0, externalPortType: 2, supportedConfigurations: [2], activeConfiguration: 2, supportedInputLevels: [], activeInputLevel: 0 }, sources: { [SRC_STEREO]: flSource({ mixOption: 4 }) } },
			1301: {
				properties: { inputType: 2, externalPortType: 512, supportedConfigurations: [1, 2, 4], activeConfiguration: 4, supportedInputLevels: [1, 2], activeInputLevel: 1 },
				sources: { [SRC_CH1]: flSource({ sourceType: 0, maxFramesDelay: 8, mixOption: 2 }), [SRC_CH2]: flSource({ sourceType: 0, maxFramesDelay: 8, mixOption: 1 }) },
			},
		},
		master: {
			properties: { faderGain: 0, followFadeToBlack: true },
			equalizer: { enabled: false, gain: 0, bands: [0, 1, 2, 3, 4, 5].map(band) },
			dynamics: {
				makeUpGain: 0,
				compressor: { compressorEnabled: false, threshold: -1000, ratio: 200, attack: 140, hold: 0, release: 9300 },
				limiter: { limiterEnabled: true, threshold: -100, attack: 70, hold: 0, release: 9300 },
			},
		},
		monitor: { gain: 0, inputMasterGain: 0, inputMasterMuted: false, inputTalkbackGain: -1000, inputTalkbackMuted: true, inputSidetoneGain: -2000 },
		solo: { solo: false, index: 0, source: '0' },
		audioFollowVideoCrossfadeTransitionEnabled: false,
	}
	s.recording = {
		status: { state: 0, error: 2, recordingTimeAvailable: 7200 },
		properties: { filename: 'ATEM', workingSet1DiskId: 1, workingSet2DiskId: 0, recordInAllCameras: false },
		recordAllInputs: false,
		disks: { 1: { diskId: 1, volumeName: 'SSD 1', recordingTimeAvailable: 7200, status: 4 } },
	}
	s.streaming = { status: { state: 1, error: 0 }, stats: { cacheUsed: 0, encodingBitrate: 6000000 } }
	return s as unknown as AtemState
}

/** A classic-mixer ATEM (a 1 M/E): SDI 1-3, XLR 1001-1002, master, monitor, headphones */
export function classicState(): AtemState {
	const s = baseState(0x02, 'ATEM 1 M/E Production Switcher')
	const ch = (sourceType: number, portType: number, mixOption: number) => ({ sourceType, portType, mixOption, gain: 0, balance: 0, supportsRcaToXlrEnabled: false, rcaToXlrEnabled: false })
	s.audio = {
		numberOfChannels: 5,
		hasMonitor: true,
		channels: { 1: ch(0, 1, 1), 2: ch(0, 1, 2), 3: ch(0, 1, 0), 1001: ch(2, 32, 1), 1002: ch(2, 32, 0) },
		master: { gain: 0, balance: 0, followFadeToBlack: false },
		monitor: { enabled: true, gain: 0, mute: false, solo: false, soloSource: 0, dim: false, dimLevel: 0 },
		headphones: { gain: 0, programOutGain: 0, sidetoneGain: -20, talkbackGain: -10 },
		audioFollowVideoCrossfadeTransitionEnabled: true,
	}
	return s as unknown as AtemState
}

const mul = (db: number) => Math.pow(10, db / 20)
const fl = (db: number | null) => (db === null ? -10000 : Math.max(-10000, Math.round(db * 100)))

export class FakeAtem extends EventEmitter<AtemLinkEvents> implements AtemLink {
	state: AtemState | undefined
	connected = false
	classicLevels = true
	calls: { method: string; args: unknown[] }[] = []
	/** Incoming signal per source key ('1', '1301.-256', 'master', classic '1001'), dB RMS; peak is +6 */
	signal: Record<string, number | null> = {}
	levelsOn = false
	connects = 0
	/** Like the ATEM's disk: on stop, the take is written here as '<file name> 01.mp4' */
	writeTo = ''
	reachable = true
	#timer: NodeJS.Timeout | null = null
	#initial: () => AtemState

	constructor(make: () => AtemState) {
		super()
		this.#initial = make
	}

	get s(): Any {
		return this.state as unknown as Any
	}

	#pending: NodeJS.Timeout | null = null
	#takeName = ''

	connect(_host: string, _port: number): void {
		if (!this.reachable) return
		this.#pending = setTimeout(() => this.#up(), 5)
	}

	#up(): void {
		this.state = this.#initial()
		this.connected = true
		this.levelsOn = false
		this.connects++
		this.emit('connected')
		if (!this.#timer) this.#timer = setInterval(() => this.#meters(), 50)
	}

	/** Pretend the network dropped, then came back */
	bounce(): void {
		this.connected = false
		this.state = undefined
		this.levelsOn = false
		this.emit('disconnected')
		this.#pending = setTimeout(() => this.#up(), 20)
	}

	async destroy(): Promise<void> {
		if (this.#timer) clearInterval(this.#timer)
		if (this.#pending) clearTimeout(this.#pending)
		this.#timer = this.#pending = null
		this.connected = false
		this.removeAllListeners()
	}

	/** Change something "on the ATEM itself" */
	external(fn: (s: Any) => void, paths: string[]): void {
		fn(this.s)
		this.emit('state', this.state!, paths)
	}

	calledWith(method: string): unknown[][] {
		return this.calls.filter((c) => c.method === method).map((c) => c.args)
	}

	async call<K extends keyof AtemCalls>(method: K, ...args: AtemCalls[K]): Promise<void> {
		this.calls.push({ method, args: structuredClone(args as unknown[]) })
		const s = this.s
		const paths: string[] = []
		const a = args as unknown as any[]
		const src = (i: number, so: string) => s.fairlight.inputs[i].sources[so]
		switch (method) {
			case 'startFairlightMixerSendLevels':
			case 'classicSendLevels':
				this.levelsOn = method === 'classicSendLevels' ? !!a[0] : true
				return
			case 'stopFairlightMixerSendLevels':
				this.levelsOn = false
				return
			case 'setFairlightAudioMixerSourceProps': {
				const [i, so, p] = a
				const x = src(i, so)
				for (const [k, v] of Object.entries(p)) {
					if (k === 'equalizerEnabled') x.equalizer.enabled = v
					else if (k === 'equalizerGain') x.equalizer.gain = v
					else if (k === 'makeUpGain') x.dynamics.makeUpGain = v
					else x.properties[k] = v
				}
				paths.push(`fairlight.inputs.${i}.sources.${so}.properties`)
				break
			}
			case 'setFairlightAudioMixerSourceEqualizerBandProps': {
				const [i, so, b, p] = a
				Object.assign(src(i, so).equalizer.bands[b], p)
				paths.push(`fairlight.inputs.${i}.sources.${so}.equalizer.bands.${b}`)
				break
			}
			case 'setFairlightAudioMixerSourceCompressorProps':
			case 'setFairlightAudioMixerSourceLimiterProps':
			case 'setFairlightAudioMixerSourceExpanderProps': {
				const [i, so, p] = a
				const which = method.includes('Compressor') ? 'compressor' : method.includes('Limiter') ? 'limiter' : 'expander'
				Object.assign(src(i, so).dynamics[which], p)
				paths.push(`fairlight.inputs.${i}.sources.${so}.dynamics.${which}`)
				break
			}
			case 'setFairlightAudioMixerInputProps': {
				const [i, p] = a
				const inp = s.fairlight.inputs[i]
				Object.assign(inp.properties, p)
				if (p.activeConfiguration === 2 || p.activeConfiguration === 1) inp.sources = { [SRC_STEREO]: inp.sources[SRC_STEREO] ?? flSource({ maxFramesDelay: 8 }) }
				if (p.activeConfiguration === 4) inp.sources = { [SRC_CH1]: flSource({ sourceType: 0, maxFramesDelay: 8 }), [SRC_CH2]: flSource({ sourceType: 0, maxFramesDelay: 8 }) }
				paths.push(`fairlight.inputs.${i}.properties`, `fairlight.inputs.${i}.sources`)
				break
			}
			case 'setFairlightAudioMixerMasterProps': {
				const p = a[0]
				const m = s.fairlight.master
				for (const [k, v] of Object.entries(p)) {
					if (k === 'equalizerEnabled') m.equalizer.enabled = v
					else if (k === 'equalizerGain') m.equalizer.gain = v
					else if (k === 'makeUpGain') m.dynamics.makeUpGain = v
					else m.properties[k] = v
				}
				paths.push('fairlight.master')
				break
			}
			case 'setFairlightAudioMixerMasterCompressorProps':
			case 'setFairlightAudioMixerMasterLimiterProps': {
				const which = method.includes('Compressor') ? 'compressor' : 'limiter'
				Object.assign(s.fairlight.master.dynamics[which], a[0])
				paths.push(`fairlight.master.dynamics.${which}`)
				break
			}
			case 'setFairlightAudioMixerMasterEqualizerBandProps':
				Object.assign(s.fairlight.master.equalizer.bands[a[0]], a[1])
				paths.push(`fairlight.master.equalizer.bands.${a[0]}`)
				break
			case 'setFairlightAudioMixerMonitorProps':
				Object.assign(s.fairlight.monitor, a[0])
				paths.push('fairlight.monitor')
				break
			case 'setFairlightAudioMixerMonitorSolo':
				Object.assign(s.fairlight.solo, a[0])
				paths.push('fairlight.solo')
				break
			case 'setFairlightAudioFollowVideoCrossfade':
				s.fairlight.audioFollowVideoCrossfadeTransitionEnabled = !!a[0]
				paths.push('fairlight.audioFollowVideoCrossfadeTransitionEnabled')
				break
			case 'setClassicAudioMixerInputProps':
				Object.assign(s.audio.channels[a[0]], a[1])
				// the ATEM keeps gain as a 16-bit number, so it comes back a hair off
				if ('gain' in a[1]) s.audio.channels[a[0]].gain = Number.isFinite(a[1].gain) ? Math.round(Math.log10(Math.floor(Math.pow(10, a[1].gain / 20) * 32768) / 32768) * 2000) / 100 : -Infinity
				paths.push(`audio.channels.${a[0]}`)
				break
			case 'setClassicAudioMixerMasterProps':
				Object.assign(s.audio.master, a[0])
				paths.push('audio.master')
				break
			case 'setClassicAudioMixerMonitorProps':
				Object.assign(s.audio.monitor, a[0])
				paths.push('audio.monitor')
				break
			case 'setClassicAudioMixerHeadphonesProps':
				Object.assign(s.audio.headphones, a[0])
				paths.push('audio.headphones')
				break
			case 'setClassicAudioMixerProps':
				s.audio.audioFollowVideoCrossfadeTransitionEnabled = a[0].audioFollowVideo
				paths.push('audio.audioFollowVideoCrossfadeTransitionEnabled')
				break
			case 'startRecording':
			case 'stopRecording':
				s.recording.status.state = method === 'startRecording' ? 1 : 0
				if (method === 'startRecording') this.#takeName = s.recording.properties.filename
				else if (this.writeTo) writeFileSync(join(this.writeTo, `${this.#takeName} 01.mp4`), 'not really a video')
				paths.push('recording.status')
				break
			case 'setRecordingSettings':
				Object.assign(s.recording.properties, a[0])
				paths.push('recording.properties')
				break
			case 'setEnableISORecording':
				s.recording.recordAllInputs = !!a[0]
				paths.push('recording.recordAllInputs')
				break
			case 'startStreaming':
			case 'stopStreaming':
				s.streaming.status.state = method === 'startStreaming' ? 4 : 1
				paths.push('streaming.status')
				break
			default:
				return
		}
		setTimeout(() => this.connected && this.emit('state', this.state!, paths), 3)
	}

	#sig(key: string, fallback: number | null = -20): number | null {
		return key in this.signal ? this.signal[key] : fallback
	}

	#meters(): void {
		if (!this.connected || !this.levelsOn || !this.state) return
		const s = this.s
		const noise = () => (Math.random() - 0.5) * 0.4
		if (s.fairlight) {
			for (const [i, inp] of Object.entries<Any>(s.fairlight.inputs)) {
				for (const [so, x] of Object.entries<Any>(inp.sources)) {
					const key = so === SRC_STEREO ? i : `${i}.${so}`
					const sig = this.#sig(key)
					const p = x.properties
					const input = sig === null ? null : sig + p.gain / 100 + noise()
					const comp = x.dynamics.compressor.compressorEnabled ? -300 : 0
					const post = input === null || p.mixOption === 1 || p.faderGain <= -10000 ? null : input + p.faderGain / 100
					const peak = (d: number | null) => (d === null ? -10000 : fl(d + 6))
					this.emit('levels', {
						system: 'fairlight',
						type: 'source',
						index: Number(i),
						source: BigInt(so),
						levels: {
							inputLeftLevel: fl(input),
							inputRightLevel: fl(input),
							inputLeftPeak: peak(input),
							inputRightPeak: peak(input),
							expanderGainReduction: 0,
							compressorGainReduction: comp,
							limiterGainReduction: 0,
							outputLeftLevel: fl(input),
							outputRightLevel: fl(input),
							outputLeftPeak: peak(input),
							outputRightPeak: peak(input),
							leftLevel: fl(post),
							rightLevel: fl(post),
							leftPeak: peak(post),
							rightPeak: peak(post),
						},
					})
				}
			}
			const m = this.#sig('master', -15)
			const mp = m === null ? null : m + s.fairlight.master.properties.faderGain / 100
			this.emit('levels', {
				system: 'fairlight',
				type: 'master',
				levels: {
					inputLeftLevel: fl(m),
					inputRightLevel: fl(m),
					inputLeftPeak: fl(m),
					inputRightPeak: fl(m),
					compressorGainReduction: 0,
					limiterGainReduction: -150,
					outputLeftLevel: fl(m),
					outputRightLevel: fl(m),
					outputLeftPeak: fl(m),
					outputRightPeak: fl(m),
					leftLevel: fl(mp),
					rightLevel: fl(mp),
					leftPeak: fl(mp === null ? null : mp + 6),
					rightPeak: fl(mp === null ? null : mp + 6),
				},
			})
		} else if (s.audio) {
			const meter = (db: number | null): ClassicMeter => {
				const v = db === null ? 0 : mul(db)
				return { left: v, right: v, leftPeak: v * 2, rightPeak: v * 2 }
			}
			const inputs = Object.entries<Any>(s.audio.channels).map(([id, c]) => {
				const sig = this.#sig(id)
				const db = sig === null || c.mixOption === 0 || !Number.isFinite(c.gain) ? null : sig + c.gain + noise()
				return { id: Number(id), levels: meter(db) }
			})
			// through the wire format and back, like the real thing
			const wire = encodeClassicLevels({ master: meter(-12 + s.audio.master.gain), monitor: meter(-30), inputs })
			this.emit('levels', parseClassicLevels(wire))
		}
	}
}
