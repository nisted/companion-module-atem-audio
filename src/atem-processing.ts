/**
 * Fairlight processing as the core's processing table: EQ, the six EQ bands,
 * expander / gate, compressor (with make-up gain) and limiter. Every input
 * has the lot, fixed (nothing to add or remove). The master has the EQ,
 * compressor and limiter, but no expander.
 *
 * Values here are in people units (dB, ms, n:1, Hz). The ATEM wants dB×100,
 * ms×100, ratio×100 and Q×100; toAtem() / fromAtem() do that.
 * Ranges are LibAtem's (atem-connection doesn't check them, and the ATEM
 * quietly ignores anything out of range). Defaults are only what a double
 * click on a knob goes back to: they're ours, not Blackmagic's.
 */

import type { ProcessingKind, ProcessingParam } from '../core/src/device.js'
import { EQ_RANGES, EQ_SHAPES } from './atem-values.js'

export const EQ_KIND = 'fl_eq'
export const BAND_KIND = 'fl_eq_band'
export const EXPANDER_KIND = 'fl_expander'
export const COMPRESSOR_KIND = 'fl_compressor'
export const LIMITER_KIND = 'fl_limiter'

const ms = (key: string, label: string, min: number, max: number, def: number): ProcessingParam => ({ key, label, type: 'number', min, max, step: 0.1, unit: 'ms', default: def })

export const FAIRLIGHT_KINDS: ProcessingKind[] = [
	{
		kind: EQ_KIND,
		label: 'EQ',
		defaultName: 'EQ',
		params: [{ key: 'gain', label: 'EQ gain', type: 'number', min: -20, max: 20, step: 0.1, unit: 'dB', default: 0 }],
	},
	{
		kind: BAND_KIND,
		label: 'EQ band',
		defaultName: 'Band',
		params: [
			{ key: 'shape', label: 'Shape', type: 'choice', default: 'bell', choices: EQ_SHAPES.map(({ id, label }) => ({ id, label })) },
			{ key: 'range', label: 'Range', type: 'choice', default: 'midlow', choices: EQ_RANGES.map(({ id, label }) => ({ id, label })) },
			{ key: 'frequency', label: 'Frequency', type: 'number', min: 30, max: 21700, step: 1, unit: 'Hz', default: 1000 },
			{ key: 'gain', label: 'Gain', type: 'number', min: -20, max: 20, step: 0.1, unit: 'dB', default: 0 },
			{ key: 'q', label: 'Q', type: 'number', min: 0.3, max: 10.3, step: 0.1, unit: '', default: 0.7 },
		],
	},
	{
		kind: EXPANDER_KIND,
		label: 'Expander / gate',
		defaultName: 'Expander',
		gainReduction: true,
		params: [
			{ key: 'gate', label: 'Mode', type: 'choice', default: 'expander', choices: [{ id: 'expander', label: 'Expander' }, { id: 'gate', label: 'Gate' }] },
			{ key: 'threshold', label: 'Threshold', type: 'number', min: -50, max: 0, step: 0.1, unit: 'dB', default: -45 },
			{ key: 'range', label: 'Range', type: 'number', min: 0, max: 60, step: 0.1, unit: 'dB', default: 18 },
			{ key: 'ratio', label: 'Ratio', type: 'number', min: 1.1, max: 3, step: 0.1, unit: ':1', default: 1.1 },
			ms('attack', 'Attack', 0.5, 100, 1.4),
			ms('hold', 'Hold', 0, 4000, 0),
			ms('release', 'Release', 50, 4000, 93),
		],
	},
	{
		kind: COMPRESSOR_KIND,
		label: 'Compressor',
		defaultName: 'Compressor',
		gainReduction: true,
		params: [
			{ key: 'threshold', label: 'Threshold', type: 'number', min: -50, max: 0, step: 0.1, unit: 'dB', default: -35 },
			{ key: 'ratio', label: 'Ratio', type: 'number', min: 1.2, max: 20, step: 0.1, unit: ':1', default: 2 },
			ms('attack', 'Attack', 0.7, 100, 1.4),
			ms('hold', 'Hold', 0, 4000, 0),
			ms('release', 'Release', 50, 4000, 93),
			{ key: 'makeUp', label: 'Make-up gain', type: 'number', min: 0, max: 20, step: 0.1, unit: 'dB', default: 0 },
		],
	},
	{
		kind: LIMITER_KIND,
		label: 'Limiter',
		defaultName: 'Limiter',
		gainReduction: true,
		params: [
			{ key: 'threshold', label: 'Threshold', type: 'number', min: -30, max: 0, step: 0.1, unit: 'dB', default: -12 },
			ms('attack', 'Attack', 0.7, 30, 0.7),
			ms('hold', 'Hold', 0, 4000, 0),
			ms('release', 'Release', 50, 4000, 93),
		],
	},
]

export function kindOf(kind: string): ProcessingKind | undefined {
	return FAIRLIGHT_KINDS.find((k) => k.kind === kind)
}

/** Block ids on a Fairlight input (the same on every input, and on the master less the expander) */
export const BAND_COUNT = 6
export const bandId = (i: number): string => `band${i + 1}`
export const bandIndex = (id: string): number => (/^band(\d)$/.test(id) ? Number(id.slice(4)) - 1 : -1)

/** Every setting of every kind, for actions: '<kind>:<key>' */
export const ALL_PARAMS = FAIRLIGHT_KINDS.flatMap((k) => k.params.map((p) => ({ id: `${k.kind}:${p.key}`, label: `${k.label}: ${p.label}`, kind: k, param: p })))

/** People units -> what the ATEM wants, for one parameter */
export function toAtem(key: string, value: unknown): number | boolean {
	if (key === 'shape') return EQ_SHAPES.find((s) => s.id === value)?.value ?? 4
	if (key === 'range') return EQ_RANGES.find((s) => s.id === value)?.value ?? 2
	if (key === 'gate') return value === 'gate' || value === true
	const n = Number(value)
	if (key === 'frequency') return Math.round(n)
	return Math.round(n * 100)
}

/** The library's field name for one of our keys */
export function atemKey(kind: string, key: string): string {
	if (kind === BAND_KIND && key === 'range') return 'frequencyRange'
	if (kind === BAND_KIND && key === 'q') return 'qFactor'
	if (kind === EXPANDER_KIND && key === 'gate') return 'gateEnabled'
	if (key === 'makeUp') return 'makeUpGain'
	return key
}

/** Clamp a value to a parameter's range (numbers) or check it's a choice; undefined = impossible */
export function checkParam(kind: string, key: string, value: unknown): unknown {
	const p = kindOf(kind)?.params.find((x) => x.key === key)
	if (!p) return undefined
	if (p.type === 'choice') {
		const c = p.choices?.find((c) => c.id === String(value).toLowerCase() || c.label.toLowerCase() === String(value).toLowerCase())
		return c?.id
	}
	const n = Number(value)
	if (value === '' || value === null || value === undefined || Number.isNaN(n)) return undefined
	return Math.min(p.max ?? Infinity, Math.max(p.min ?? -Infinity, n))
}

export const shapeId = (v: number | undefined): string => EQ_SHAPES.find((s) => s.value === v)?.id ?? 'bell'
export const rangeId = (v: number | undefined): string => EQ_RANGES.find((s) => s.value === v)?.id ?? 'midlow'
