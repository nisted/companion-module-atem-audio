/**
 * ATEM numbers and conversions, from atem-connection 3.10.3 (see
 * /upstream and the research notes): our own copies of the enum values we
 * need, so the device adapter and the tests don't load the library at all.
 *
 * Fairlight gains are whole numbers of hundredths of a dB (dB×100), with
 * -10000 meaning -inf. Classic gains come out of the library already as dB.
 */

import type { Db } from '../core/src/law.js'

// ---- Fairlight ---------------------------------------------------------------

export const FL_INF = -10000

/** dB×100 to dB (null = -inf) */
export function flToDb(raw: number | undefined): Db {
	if (raw === undefined || !Number.isFinite(raw) || raw <= FL_INF) return null
	return raw / 100
}

/** dB (null = -inf) to dB×100, clamped to the given dB range */
export function dbToFl(db: Db, minDb = -100, maxDb = 10): number {
	if (db === null || Number.isNaN(db) || db <= -100) return FL_INF
	return Math.round(Math.min(maxDb, Math.max(minDb, db)) * 100)
}

/** A Fairlight meter value (dB×100) as a linear multiplier (1 = 0 dBFS) */
export function flLevelToMul(raw: number | undefined): number {
	if (raw === undefined || !Number.isFinite(raw) || raw <= FL_INF) return 0
	return Math.pow(10, raw / 2000)
}

/** Fairlight gain reduction (dB×100, 0 or below) as positive dB */
export function flGainReduction(raw: number | undefined): number {
	if (raw === undefined || !Number.isFinite(raw) || raw >= 0) return 0
	return -raw / 100
}

/** FairlightAudioMixOption */
export const FL_MIX = { off: 1, on: 2, afv: 4 } as const
/** AudioMixOption (classic): different numbers to Fairlight */
export const CL_MIX = { off: 0, on: 1, afv: 2 } as const

export type MixId = 'off' | 'on' | 'afv'
export const MIX_LABELS: Record<MixId, string> = { on: 'On', off: 'Off', afv: 'Audio follow video' }

export function flMixId(v: number | undefined): MixId {
	return v === FL_MIX.off ? 'off' : v === FL_MIX.afv ? 'afv' : 'on'
}
export function clMixId(v: number | undefined): MixId {
	return v === CL_MIX.off ? 'off' : v === CL_MIX.afv ? 'afv' : 'on'
}

/** Fairlight source ids (bigint as text) */
export const SRC_STEREO = '-65280'
export const SRC_CH1 = '-256'
export const SRC_CH2 = '-255'

/** FairlightAudioSourceType */
export const FL_SOURCE_MONO = 0

/** EQ band shapes (LibAtem's enum; atem-connection types it as a plain number) */
export const EQ_SHAPES = [
	{ id: 'lowshelf', label: 'Low shelf', value: 1 },
	{ id: 'lowpass', label: 'Low pass', value: 2 },
	{ id: 'bell', label: 'Bell', value: 4 },
	{ id: 'notch', label: 'Notch', value: 8 },
	{ id: 'highpass', label: 'High pass', value: 16 },
	{ id: 'highshelf', label: 'High shelf', value: 32 },
]
export const EQ_RANGES = [
	{ id: 'low', label: 'Low', value: 1 },
	{ id: 'midlow', label: 'Mid low', value: 2 },
	{ id: 'midhigh', label: 'Mid high', value: 4 },
	{ id: 'high', label: 'High', value: 8 },
]

// ---- models, ports -------------------------------------------------------------

/** Enums.Model values we need */
export const MODEL = {
	MiniPro: 0x0e,
	MiniProISO: 0x0f,
	MiniExtreme: 0x10,
	MiniExtremeISO: 0x11,
	SDIExtremeISO: 0x17,
	TelevisionStudioHD8: 0x1a,
	TelevisionStudioHD8ISO: 0x1b,
	TelevisionStudio4K8: 0x20,
	MiniExtremeISOG2: 0x21,
	Constellation: 0x0b,
	Constellation8K: 0x0c,
	ConstellationHD1ME: 0x12,
	ConstellationHD2ME: 0x13,
	ConstellationHD4ME: 0x14,
	Constellation4K1ME: 0x1c,
	Constellation4K2ME: 0x1d,
	Constellation4K4ME: 0x1e,
	Constellation4K4MEPlus: 0x1f,
} as const

/**
 * Models whose headphone output has separate programme / talkback / sidetone
 * levels (the official module's 'split' monitor type). Others with a monitor
 * out ('combined', e.g. TVS Pro 4K) only get the overall level.
 */
export const SPLIT_MONITOR_MODELS = new Set<number>([
	MODEL.MiniExtreme,
	MODEL.MiniExtremeISO,
	MODEL.MiniExtremeISOG2,
	MODEL.SDIExtremeISO,
	MODEL.TelevisionStudioHD8,
	MODEL.TelevisionStudioHD8ISO,
	MODEL.TelevisionStudio4K8,
	MODEL.Constellation,
	MODEL.Constellation8K,
	MODEL.ConstellationHD1ME,
	MODEL.ConstellationHD2ME,
	MODEL.ConstellationHD4ME,
	MODEL.Constellation4K1ME,
	MODEL.Constellation4K2ME,
	MODEL.Constellation4K4ME,
	MODEL.Constellation4K4MEPlus,
])

/** Models users report have a built-in FTP server for the recording disk (not tested by us) */
export const FTP_MODELS = new Set<number>([MODEL.MiniPro, MODEL.MiniProISO, MODEL.MiniExtreme, MODEL.MiniExtremeISO, MODEL.MiniExtremeISOG2])

/** Enums.ExternalPortType values we need */
export const PORT = { SDI: 1, HDMI: 2, XLR: 32, AESEBU: 64, RCA: 128, Internal: 256, TSJack: 512, MADI: 1024, TRSJack: 2048, RJ45: 4096 } as const

/** A label for an audio input with no name of its own, the way the official module does it */
export function audioInputLabel(id: number, portType: number | undefined, videoName: string | undefined, xlrCount: number): string {
	if (videoName) return videoName
	switch (portType) {
		case PORT.XLR:
			return xlrCount > 1 ? `XLR ${id - 1000}` : 'XLR'
		case PORT.AESEBU:
			return 'AES/EBU'
		case PORT.RCA:
			return 'RCA'
		case PORT.TSJack:
			return `Mic ${id - 1300}`
		case PORT.MADI:
			return `MADI ${id - 1500}`
		case PORT.TRSJack:
			return 'TRS'
		case PORT.RJ45:
			return 'RJ45'
		case PORT.Internal:
			return id === 2051 ? 'Thunderbolt' : `Media Player ${id - 2000}`
		default:
			if (id >= 2001 && id < 2051) return `Media Player ${id - 2000}`
			return `Input ${id}`
	}
}

// ---- recording / streaming ------------------------------------------------------

export const REC_STATUS = { Idle: 0, Recording: 1, Stopping: 128 } as const
export const REC_ERROR: Record<number, string> = {
	0: 'no disk',
	2: '',
	4: 'disk full',
	8: 'disk error',
	16: 'disk not formatted',
	32: 'dropping frames',
	32768: 'unknown problem',
}
export const STREAM_STATUS = { Idle: 1, Connecting: 2, Streaming: 4, Stopping: 32 } as const
export const DISK_STATUS = { Idle: 1, Unformatted: 2, Active: 4, Recording: 8, Removed: 32 } as const

/** Protocol version (e.g. 0x00020020) as text, with the ATEM software version it came with where known */
export function protocolText(v: number | undefined): string {
	if (!v) return ''
	const known: Record<number, string> = {
		0x00020016: '7.2',
		0x0002001b: '7.5.2',
		0x0002001c: '8.0',
		0x0002001d: '8.0.1',
		0x0002001e: '8.1.1',
		0x0002001f: '9.4',
		0x00020020: '9.6',
	}
	const p = `${v >>> 16}.${v & 0xffff}`
	return known[v] ? `${p} (ATEM ${known[v]} or later)` : p
}
