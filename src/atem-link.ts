/**
 * Our own thin layer in front of atem-connection's Atem class. The device
 * adapter (atem-device.ts) only ever talks to an AtemLink, so the tests can
 * swap in a pretend ATEM (test/fake-atem.ts) and nothing here loads the
 * library itself (only `import type`). The real one is atem-link-real.ts.
 *
 * One AtemLink = one Atem = one of the switcher's control slots.
 */

import type { EventEmitter } from 'node:events'
import type { Atem, AtemState } from 'atem-connection'
import type { SomeAtemAudioLevels } from 'atem-connection/dist/state/levels.js'
import type { ClassicLevels } from './classic-levels.js'

/** The library methods the adapter uses */
export type LibMethod =
	| 'setFairlightAudioMixerSourceProps'
	| 'setFairlightAudioMixerSourceCompressorProps'
	| 'setFairlightAudioMixerSourceLimiterProps'
	| 'setFairlightAudioMixerSourceExpanderProps'
	| 'setFairlightAudioMixerSourceEqualizerBandProps'
	| 'setFairlightAudioMixerSourceDynamicsReset'
	| 'setFairlightAudioMixerSourceEqualizerReset'
	| 'setFairlightAudioMixerSourceResetPeaks'
	| 'setFairlightAudioMixerInputProps'
	| 'setFairlightAudioMixerMasterProps'
	| 'setFairlightAudioMixerMasterCompressorProps'
	| 'setFairlightAudioMixerMasterLimiterProps'
	| 'setFairlightAudioMixerMasterEqualizerBandProps'
	| 'setFairlightAudioMixerMasterEqualizerReset'
	| 'setFairlightAudioMixerMasterDynamicsReset'
	| 'setFairlightAudioMixerResetPeaks'
	| 'setFairlightAudioMixerMonitorProps'
	| 'setFairlightAudioMixerMonitorSolo'
	| 'startFairlightMixerSendLevels'
	| 'stopFairlightMixerSendLevels'
	| 'setClassicAudioMixerInputProps'
	| 'setClassicAudioMixerMasterProps'
	| 'setClassicAudioMixerMonitorProps'
	| 'setClassicAudioMixerHeadphonesProps'
	| 'setClassicAudioMixerProps'
	| 'setClassicAudioResetPeaks'
	| 'startRecording'
	| 'stopRecording'
	| 'requestRecordingDuration'
	| 'switchRecordingDisk'
	| 'setRecordingSettings'
	| 'setEnableISORecording'
	| 'startStreaming'
	| 'stopStreaming'
	| 'requestStreamingDuration'

/** Everything `call` can do: the library's methods, plus two of ours */
export type AtemCalls = { [K in LibMethod]: Parameters<Atem[K]> } & {
	/** Fairlight's audio-follow-video crossfade (no library method; raw CMPP command) */
	setFairlightAudioFollowVideoCrossfade: [on: boolean]
	/** Classic levels on/off (SALN: not in the library, see classic-levels.ts) */
	classicSendLevels: [on: boolean]
}

export interface AtemLinkEvents {
	connected: []
	disconnected: []
	/** State changed (not during the initial dump), with the paths that changed */
	state: [state: AtemState, paths: string[]]
	levels: [levels: SomeAtemAudioLevels | ClassicLevels]
	error: [msg: string]
	info: [msg: string]
}

export interface AtemLink extends EventEmitter<AtemLinkEvents> {
	readonly state: Readonly<AtemState> | undefined
	readonly connected: boolean
	/** False when classic levels couldn't be hooked into this library version */
	readonly classicLevels: boolean
	/** Start connecting; the library keeps retrying by itself */
	connect(host: string, port: number): void
	/** Disconnect cleanly (frees the ATEM's control slot) and stop */
	destroy(): Promise<void>
	call<K extends keyof AtemCalls>(method: K, ...args: AtemCalls[K]): Promise<void>
}
