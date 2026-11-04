# atem-connection: classic audio mixer levels (SALN / AMLv)

A change offered to [Sofie-Automation/sofie-atem-connection](https://github.com/Sofie-Automation/sofie-atem-connection), written against **3.10.3**. Ready to paste into an issue, or to turn into a PR.

## The problem

ATEMs with the classic (pre-Fairlight) audio mixer send meter levels only when asked, as Fairlight ones do. atem-connection has the Fairlight pair (`SFLN` / `FMLv` + `FDLv`, `startFairlightMixerSendLevels()`, `levelChanged`), but not the classic pair:

- `SALN` (client → ATEM): send levels on / off. Not implemented, so there's no way to ask.
- `AMLv` (ATEM → client): the levels. Not implemented, so if anything else asks for them, every packet is dropped with a debug `Unknown command AMLv`.

So a classic ATEM (Television Studio, TVS HD / Pro HD, 1 / 2 / 4 M/E, 4K, Production Studio 4K) has no meters through the library.

## Wire format

From LibAtem's `AudioMixerSendLevelsCommand.cs` and `AudioMixerLevelsCommand.cs` (BSD-licensed C#, a long-standing reference):

**SALN**, 4 bytes: `u8 sendLevels` (1 / 0), 3 bytes padding.

**AMLv**:

| bytes | field |
|---|---|
| u16 | input count (n) |
| u16 | padding (LibAtem writes n again) |
| 8 × u32 | master L level, R level, L peak, R peak; monitor L level, R level, L peak, R peak |
| n × u16 | source ids (same ids as `state.audio.channels`) |
| 0 or 2 | padding to a multiple of 4 |
| n × 4 × u32 | per source: L level, R level, L peak, R peak |

Each u32 is linear, with 0 dBFS = 128 × 65536 = 8388608: `dB = 20 * log10(v / 8388608)`.

Not yet checked byte for byte against a real classic ATEM by us (none to hand). LibAtem's tests and ATEM Software Control captures are where it comes from.

## Proposed change

Mirrors the Fairlight levels exactly: commands in `src/commands/Audio/`, a method in the command sender mixin, the levels on the existing `levelChanged` event with `system: 'classic'`, and no state (levels never touch `AtemState`, as with Fairlight).

### `src/commands/Audio/AudioMixerSendLevelsCommand.ts`

```ts
import { BasicWritableCommand } from '../CommandBase'

export class AudioMixerSendLevelsCommand extends BasicWritableCommand<{ sendLevels: boolean }> {
	public static readonly rawName = 'SALN'

	constructor(sendLevels: boolean) {
		super({ sendLevels })
	}

	public serialize(): Buffer {
		const buffer = Buffer.alloc(4)
		buffer.writeUInt8(this.properties.sendLevels ? 1 : 0, 0)
		return buffer
	}
}
```

### `src/commands/Audio/AudioMixerLevelsCommand.ts`

```ts
import { DeserializedCommand } from '../CommandBase'
import type { ClassicAudioLevels, ClassicAudioMeter } from '../../state/levels'

const FULL_SCALE = 128 * 65536

function decibel(raw: number): number {
	// 0 = silence; keep it finite like the Fairlight levels (-10000 = -100 dB)
	return raw <= 0 ? -10000 : Math.round(Math.log10(raw / FULL_SCALE) * 2000)
}

export class AudioMixerLevelsCommand extends DeserializedCommand<ClassicAudioLevels> {
	public static readonly rawName = 'AMLv'

	public static deserialize(rawCommand: Buffer): AudioMixerLevelsCommand {
		const count = rawCommand.readUInt16BE(0)
		let offset = 4
		const meter = (): ClassicAudioMeter => {
			const m = {
				leftLevel: decibel(rawCommand.readUInt32BE(offset)),
				rightLevel: decibel(rawCommand.readUInt32BE(offset + 4)),
				leftPeak: decibel(rawCommand.readUInt32BE(offset + 8)),
				rightPeak: decibel(rawCommand.readUInt32BE(offset + 12)),
			}
			offset += 16
			return m
		}
		const master = meter()
		const monitor = meter()
		const ids: number[] = []
		for (let i = 0; i < count; i++) ids.push(rawCommand.readUInt16BE(offset + i * 2))
		offset += Math.ceil((count * 2) / 4) * 4
		const sources = ids.map((index) => ({ index, levels: meter() }))
		return new AudioMixerLevelsCommand({ master, monitor, sources })
	}

	public applyToState(): string[] {
		// Not stored in the state
		return []
	}
}
```

(dB × 100, so the numbers line up with the Fairlight levels. Raw linear values would be fine too, if you'd rather.)

### `src/state/levels.ts`

```ts
export type SomeAtemAudioLevels = FairlightAudioSourceLevels | FairlightAudioMasterLevels | ClassicAudioLevelsEvent

export interface ClassicAudioMeter {
	/** dB × 100 */
	leftLevel: number
	rightLevel: number
	leftPeak: number
	rightPeak: number
}
export interface ClassicAudioLevels {
	master: ClassicAudioMeter
	monitor: ClassicAudioMeter
	sources: Array<{ index: number; levels: ClassicAudioMeter }>
}
export interface ClassicAudioLevelsEvent extends ClassicAudioLevels {
	system: 'classic'
	type: 'all'
}
```

(`AtemAudioLevelsBase.system` would widen to `'fairlight' | 'classic'`.)

### `src/lib/atemCommands.ts`, next to `startFairlightMixerSendLevels`

```ts
public startClassicAudioMixerSendLevels(): T {
	return this.sendCommand(new Commands.AudioMixerSendLevelsCommand(true))
}

public stopClassicAudioMixerSendLevels(): T {
	return this.sendCommand(new Commands.AudioMixerSendLevelsCommand(false))
}
```

### `src/atem.ts`, in `_mutateState`, next to the Fairlight level branches

```ts
} else if (command instanceof Commands.AudioMixerLevelsCommand) {
	this.emitter.emit('levelChanged', { system: 'classic', type: 'all', ...command.properties })
}
```

Plus the two exports in `src/commands/Audio/index.ts`, and tests:

- `AMLv` with an odd number of sources (checks the padding), with known values: 8388608 → 0 dB (0), 838861 → −20 dB (−2000), 0 → −10000.
- `SALN` serialises to `01 00 00 00`.
- `levelChanged` fires with `system: 'classic'` and `stateChanged` doesn't.

As with Fairlight, the switcher forgets the request on every reconnect, so callers re-send it on `connected`. Worth a line in the README.

## What ATEM Audio does until then

[ATEM Audio](https://github.com/nisted/companion-module-atem-audio) does the same thing from outside the library, in `src/classic-levels.ts`, without patching it:

- `SALN` goes out through `atem.sendCommand()`, which takes any object with a static `rawName` and `serialize()`.
- For `AMLv`, it adds its own command class to the parser's table (`client.socket._commandParser.commands.AMLv`). The library then parses it and hands it over on `receivedCommands`. Its `applyToState` returns no paths, so nothing else changes.

That reaches into private fields, so it checks they're there first and turns classic meters off (and says so in the debug log) if a library update moves them. Once this lands upstream, ATEM Audio switches to `startClassicAudioMixerSendLevels()` and `levelChanged`, and the hook goes.

Licence: MIT, same as atem-connection. Happy for it to be used as is. Nigel Isted.
