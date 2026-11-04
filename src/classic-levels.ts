/**
 * Meters for the classic (pre-Fairlight) ATEM audio mixer.
 *
 * atem-connection 3.10.3 doesn't know these two commands, so it never asks for
 * classic levels and drops the replies ("Unknown command AMLv"). This file adds
 * them from our side, without changing the library:
 *
 *  - SALN (to the ATEM): "send levels" on/off. The library's sendCommand()
 *    takes any command object with a static rawName and serialize(), so this
 *    one just works.
 *  - AMLv (from the ATEM): the levels. The library picks a parser for each
 *    incoming command from a table built from its own exports. We add ours to
 *    that table (hookClassicLevels). From then on the library hands AMLv to us
 *    like any other command, through its 'receivedCommands' event. Our command
 *    changes no state, so it never fires 'stateChanged'.
 *
 * The table lives on private fields (client.socket._commandParser.commands),
 * so the hook checks they're there and says so if a library update moves
 * them. The proper fix is upstream: see upstream/atem-connection-classic-levels.md.
 *
 * Wire format, from LibAtem's AudioMixerLevelsCommand (the C# library):
 *   u16 input count, 2 bytes padding
 *   8 × u32: master L level, R level, L peak, R peak, then the monitor's four
 *   input count × u16: source ids, padded to a multiple of 4 bytes
 *   input count × 4 × u32: L level, R level, L peak, R peak
 * Each u32 is linear with 0 dBFS = 128 × 65536 = 8388608.
 * Not yet checked against a real classic ATEM (none to hand).
 */

/** 0 dBFS in the classic level encoding */
export const CLASSIC_FULL_SCALE = 8388608

/** Four meters (linear, 1 = 0 dBFS) */
export interface ClassicMeter {
	left: number
	right: number
	leftPeak: number
	rightPeak: number
}

export interface ClassicLevels {
	system: 'classic'
	master: ClassicMeter
	monitor: ClassicMeter
	/** By classic audio source id (the same ids as state.audio.channels) */
	inputs: { id: number; levels: ClassicMeter }[]
}

/** Parse an AMLv payload (the bytes after the 8-byte command header). Throws on a short or garbled one. */
export function parseClassicLevels(buf: Uint8Array): ClassicLevels {
	const b = Buffer.from(buf.buffer, buf.byteOffset, buf.byteLength)
	if (b.length < 36) throw new Error(`AMLv too short (${b.length} bytes)`)
	const count = b.readUInt16BE(0)
	let p = 4
	const u32 = () => {
		if (p + 4 > b.length) throw new Error(`AMLv too short for ${count} inputs (${b.length} bytes)`)
		const v = b.readUInt32BE(p)
		p += 4
		return v / CLASSIC_FULL_SCALE
	}
	const meter = (): ClassicMeter => ({ left: u32(), right: u32(), leftPeak: u32(), rightPeak: u32() })
	const master = meter()
	const monitor = meter()
	const ids: number[] = []
	for (let i = 0; i < count; i++) {
		if (p + 2 > b.length) throw new Error(`AMLv too short for ${count} inputs (${b.length} bytes)`)
		ids.push(b.readUInt16BE(p))
		p += 2
	}
	p = Math.ceil(p / 4) * 4
	const inputs = ids.map((id) => ({ id, levels: meter() }))
	return { system: 'classic', master, monitor, inputs }
}

/** Build an AMLv payload (for tests and the fake ATEM) */
export function encodeClassicLevels(l: Omit<ClassicLevels, 'system'>): Buffer {
	const count = l.inputs.length
	const idsLen = Math.ceil((count * 2) / 4) * 4
	const b = Buffer.alloc(4 + 32 + idsLen + count * 16)
	b.writeUInt16BE(count, 0)
	b.writeUInt16BE(count, 2)
	let p = 4
	const put = (v: number) => {
		b.writeUInt32BE(Math.max(0, Math.min(0xffffffff, Math.round(v * CLASSIC_FULL_SCALE))), p)
		p += 4
	}
	const meter = (m: ClassicMeter) => [m.left, m.right, m.leftPeak, m.rightPeak].forEach(put)
	meter(l.master)
	meter(l.monitor)
	for (const i of l.inputs) {
		b.writeUInt16BE(i.id, p)
		p += 2
	}
	p = 36 + idsLen
	for (const i of l.inputs) meter(i.levels)
	return b
}

/** SALN: ask the ATEM to send (or stop sending) classic levels. Shaped like the library's own commands. */
export class ClassicSendLevelsCommand {
	static readonly rawName = 'SALN'
	runOrderGroup = 0
	constructor(readonly sendLevels: boolean) {}
	get properties(): { sendLevels: boolean } {
		return { sendLevels: this.sendLevels }
	}
	serialize(): Buffer {
		const b = Buffer.alloc(4)
		b.writeUInt8(this.sendLevels ? 1 : 0, 0)
		return b
	}
}

/** AMLv as the library's parser expects a command class to look */
export class ClassicLevelsUpdateCommand {
	static readonly rawName = 'AMLv'
	constructor(readonly properties: ClassicLevels) {}
	static deserialize(raw: Buffer): ClassicLevelsUpdateCommand {
		return new ClassicLevelsUpdateCommand(parseClassicLevels(raw))
	}
	/** Levels aren't state: nothing changes, so the library raises no stateChanged */
	applyToState(): string[] {
		return []
	}
}

interface ParserLike {
	commands: Record<string, unknown[]>
	commandFromRawName(name: string): unknown
}

/**
 * Teach an Atem (from atem-connection) to parse AMLv. True if it worked; false
 * if the library has changed shape (then classic meters stay off, nothing else breaks).
 */
export function hookClassicLevels(atem: unknown): boolean {
	const parser = (atem as { client?: { socket?: { _commandParser?: ParserLike } } } | undefined)?.client?.socket?._commandParser
	if (!parser || typeof parser.commands !== 'object' || typeof parser.commandFromRawName !== 'function') return false
	const list = (parser.commands.AMLv ??= [])
	if (!list.includes(ClassicLevelsUpdateCommand)) list.push(ClassicLevelsUpdateCommand)
	return parser.commandFromRawName('AMLv') === ClassicLevelsUpdateCommand
}
