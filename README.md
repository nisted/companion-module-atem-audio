# companion-module-atem-audio

A Bitfocus Companion module that turns a Blackmagic ATEM's audio into a desk: auto level and calibrate per input (riding the Fairlight trim or the fader), Intech Grid faders with pickup, Fairlight EQ and dynamics with gain-reduction meters, classic mixer meters, PFL / solo on the ATEM's solo, the ATEM's recording and streaming, and a fader and meter web page that can join up with other ATEM Audio and OBS Audio pages.

See [companion/HELP.md](companion/HELP.md) for how to use it.

## Building

Every push builds the module package on GitHub (Actions tab → latest run → `companion-module-atem-audio` artifact). Tags `v*` attach the `.tgz` to the release. Import it in Companion with **Modules → Import module package**.

The shared engine lives in a git submodule at `core/` ([nisted/rebel-audio-core](https://github.com/nisted/rebel-audio-core)), so clone with `git clone --recursive` (or run `git submodule update --init` after cloning).

Locally: `corepack enable`, `yarn install`, `yarn check-types`, `yarn test`, `yarn package`.

`atem-connection` isn't bundled: it runs its socket in a worker thread loaded from its own files, so it's installed next to the module (`build-config.cjs`), as the official ATEM module does.

## Layout

- `core/` (submodule): the generic engine, auto level, pickup, gestures, settings, features, recordings, the web server and the page. See `core/src/device.ts` for the Device interface.
- `src/atem-device.ts`: an ATEM as a core Device (Fairlight and classic: inputs, split mono, master, headphones, talkback, processing, meters, recording).
- `src/atem-link.ts`: our thin interface in front of atem-connection's `Atem` (the tests fake this). `src/atem-link-real.ts` is the real one.
- `src/classic-levels.ts`: classic mixer meters (SALN / AMLv), which atem-connection 3.10.3 hasn't got. See [upstream/atem-connection-classic-levels.md](upstream/atem-connection-classic-levels.md) for the fix offered upstream.
- `src/atem-processing.ts`: Fairlight EQ and dynamics as the core's processing table.
- `src/atem-values.ts`: the ATEM's numbers (dB×100, enums, model lists).
- `src/upgrades.ts`: upgrade scripts for buttons and triggers from older versions.
- `src/main.ts`: Companion actions, feedbacks, variables and presets.
- `test/`: tests and a pretend ATEM (`test/fake-atem.ts`).

## Licence

MIT, Nigel Isted. Part of the Rebels: https://github.com/nisted/companion-modules
