import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Engine, type EngineHost, type UserChange } from '../core/src/engine.js'
import { mulToDb } from '../core/src/law.js'
import { ATEM_INFO, AtemDevice, atemEngineOptions, trimBytes } from '../src/atem-device.js'
import { FakeAtem, classicState, fairlightState } from './fake-atem.js'
import { dbToFl, flGainReduction, flLevelToMul, flToDb } from '../src/atem-values.js'
import { CLASSIC_FULL_SCALE, ClassicLevelsUpdateCommand, ClassicSendLevelsCommand, encodeClassicLevels, hookClassicLevels, parseClassicLevels } from '../src/classic-levels.js'
import { Atem } from 'atem-connection'
import { PacketBuilder } from 'atem-connection/dist/lib/packetBuilder.js'
import AtemAudioInstance, { folderProblem, recordedAction, UpgradeScripts, type Config } from '../src/main.js'

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
const until = async (fn: () => boolean, ms = 2000) => {
	for (let t = 0; t < ms && !fn(); t += 20) await sleep(20)
	assert.ok(fn(), 'timed out waiting')
}

function rig(make: () => ReturnType<typeof fairlightState>, store?: unknown, metersQuietMs?: number) {
	const atem = new FakeAtem(make)
	const logs: string[] = []
	const changes: UserChange[] = []
	const host: EngineHost = { log: (l, m) => logs.push(`${l}: ${m}`), save: () => {}, structureChanged: () => {}, stateChanged: () => {} }
	const engine = new Engine(host, ATEM_INFO, atemEngineOptions(), store, '')
	engine.on('userChange', (c: UserChange) => changes.push(c))
	const device = new AtemDevice({ host: '10.0.0.9', port: 9910, makeLink: () => atem, unreachableMs: 200, metersQuietMs })
	engine.useDevice(device)
	return { atem, engine, device, logs, changes }
}

test('dB×100 and meter conversions', () => {
	assert.equal(flToDb(-10000), null)
	assert.equal(flToDb(-12000), null)
	assert.equal(flToDb(-1850), -18.5)
	assert.equal(flToDb(600), 6)
	assert.equal(dbToFl(null), -10000)
	assert.equal(dbToFl(-6.004), -600)
	assert.equal(dbToFl(12, -100, 10), 1000, 'clamped to the top')
	assert.equal(dbToFl(-140), -10000)
	assert.ok(Math.abs(flLevelToMul(-2000) - 0.1) < 1e-12)
	assert.equal(flLevelToMul(-10000), 0)
	assert.ok(Math.abs(mulToDb(flLevelToMul(-1234))! - -12.34) < 1e-9)
	assert.equal(flGainReduction(-350), 3.5)
	assert.equal(flGainReduction(0), 0)
	assert.equal(flGainReduction(20), 0)
	assert.equal(trimBytes('Ünïcødé'.repeat(30), 128).length <= 128, true)
	assert.ok(Buffer.byteLength(trimBytes('é'.repeat(100), 128)) <= 128)
})

test('classic levels: AMLv parsed as LibAtem lays it out (odd input count, padding)', () => {
	// built by hand, byte by byte: 3 inputs
	const b = Buffer.alloc(4 + 32 + 8 + 3 * 16)
	b.writeUInt16BE(3, 0)
	b.writeUInt16BE(3, 2)
	const vals = [1, 0.5, 1, 0.5, 0.1, 0.1, 0.2, 0.2]
	vals.forEach((v, i) => b.writeUInt32BE(Math.round(v * CLASSIC_FULL_SCALE), 4 + i * 4))
	;[1, 2, 1001].forEach((id, i) => b.writeUInt16BE(id, 36 + i * 2))
	// 6 bytes of ids, padded to 8
	const lv = [0.01, 0.01, 0.02, 0.02]
	for (let n = 0; n < 3; n++) lv.forEach((v, i) => b.writeUInt32BE(Math.round(v * (n + 1) * CLASSIC_FULL_SCALE), 44 + n * 16 + i * 4))
	const l = parseClassicLevels(b)
	assert.equal(l.master.left, 1, '8388608 = 0 dBFS')
	assert.ok(Math.abs(mulToDb(l.master.right)! - -6.0206) < 0.001)
	assert.ok(Math.abs(mulToDb(l.monitor.left)! - -20) < 0.001)
	assert.deepEqual(
		l.inputs.map((i) => i.id),
		[1, 2, 1001],
	)
	assert.ok(Math.abs(mulToDb(l.inputs[2].levels.left)! - 20 * Math.log10(0.03)) < 0.001)
	assert.ok(Math.abs(l.inputs[1].levels.rightPeak - 0.04) < 1e-6)
	// our encoder writes the same bytes
	assert.deepEqual(parseClassicLevels(encodeClassicLevels(l)), l)
	assert.throws(() => parseClassicLevels(b.subarray(0, 50)), /too short/)
	assert.throws(() => parseClassicLevels(Buffer.alloc(10)), /too short/)
	// even count: no padding needed
	const two = encodeClassicLevels({ ...l, inputs: l.inputs.slice(0, 2) })
	assert.equal(two.length, 4 + 32 + 4 + 2 * 16)
	assert.equal(parseClassicLevels(two).inputs[1].id, 2)
})

test('classic levels hook into atem-connection: SALN goes out, AMLv comes back as a command', () => {
	const atem = new Atem()
	assert.equal(hookClassicLevels(atem), true)
	assert.equal(hookClassicLevels(atem), true, 'hooking twice is harmless')
	assert.equal(hookClassicLevels({}), false, 'an unknown shape is refused, not crashed on')
	// SALN through the library's own packet builder
	const pb = new PacketBuilder(1400, 0x00020020)
	pb.addCommand(new ClassicSendLevelsCommand(true))
	const [pkt] = pb.getPackets()
	assert.equal(pkt.toString('ascii', 4, 8), 'SALN')
	assert.equal(pkt.readUInt16BE(0), 12)
	assert.equal(pkt[8], 1)
	// AMLv through the library's own parser
	const payload = encodeClassicLevels({ master: { left: 0.5, right: 0.5, leftPeak: 1, rightPeak: 1 }, monitor: { left: 0, right: 0, leftPeak: 0, rightPeak: 0 }, inputs: [{ id: 1, levels: { left: 0.25, right: 0.25, leftPeak: 0.5, rightPeak: 0.5 } }] })
	const head = Buffer.alloc(8)
	head.writeUInt16BE(payload.length + 8, 0)
	head.write('AMLv', 4, 'ascii')
	const got: unknown[] = []
	atem.on('receivedCommands', (cmds) => got.push(...cmds))
	const changed: unknown[] = []
	atem.on('stateChanged', (_s, p) => changed.push(p))
	const socket = (atem as unknown as { client: { socket: { _parseCommands(b: Buffer): unknown } } }).client.socket
	socket._parseCommands(Buffer.concat([head, payload]))
	assert.equal(got.length, 1)
	assert.ok(got[0] instanceof ClassicLevelsUpdateCommand)
	assert.equal((got[0] as ClassicLevelsUpdateCommand).properties.inputs[0].levels.left, 0.25)
	assert.equal(changed.length, 0, 'levels are not state')
})

test('Fairlight: inputs, split mono, buses, and every setter as the right library call', async (t) => {
	const { atem, engine, device, logs } = rig(fairlightState)
	t.after(() => engine.destroy())
	await until(() => engine.visible().length > 0)
	assert.deepEqual(
		engine.visible().map((i) => [i.id, i.name]),
		[
			['in1', 'Presenter cam'],
			['in2', 'Laptop'],
			['in1301.1', 'Mic 1 ch 1'],
			['in1301.2', 'Mic 1 ch 2'],
			['master', 'Master'],
			['monitor', 'Headphones'],
			['phones_prog', 'Headphones: programme'],
			['talkback', 'Talkback'],
			['sidetone', 'Sidetone'],
		],
	)
	assert.equal(device.mixer, 'fairlight')
	assert.equal(engine.versions.deviceVersion, '2.32 (ATEM 9.6 or later)')
	const cam = engine.resolve('in1')!
	const mic = engine.resolve('Mic 1 ch 1')!
	const master = engine.resolve('master')!
	assert.ok(cam.caps.trim && cam.caps.monitor && !cam.caps.delay, 'HDMI: trim and solo, no delay')
	assert.equal(mic.caps.delay?.max, 8)
	assert.equal(mic.channels, 1)
	assert.equal(engine.resolve('in2')!.mixOption, 'afv')
	assert.equal(engine.resolve('in1301.2')!.muted, true, 'off = muted')
	assert.equal(master.caps.role, 'master')
	assert.equal(master.mixOption, 'ftb')
	assert.deepEqual(
		cam.blocks.map((b) => b.id),
		['eq', 'band1', 'band2', 'band3', 'band4', 'band5', 'band6', 'expander', 'compressor', 'limiter'],
	)
	assert.ok(!master.blocks.some((b) => b.id === 'expander'), 'no expander on the master')
	assert.equal(cam.blocks.find((b) => b.id === 'band1')!.settings.shape, 'highpass')
	assert.equal(cam.blocks.find((b) => b.id === 'compressor')!.settings.threshold, -35)
	assert.ok(atem.calledWith('startFairlightMixerSendLevels').length >= 1, 'asked for meters')

	const last = (m: string) => atem.calledWith(m).at(-1)
	engine.setVolume(cam, -6)
	engine.setTrim(cam, 4.5)
	await engine.setBalance(cam, 0.75)
	await engine.setDelay(mic, 3)
	await sleep(30)
	const props = atem.calledWith('setFairlightAudioMixerSourceProps')
	assert.deepEqual(props[0], [1, '-65280', { faderGain: -600 }])
	assert.deepEqual(props[1], [1, '-65280', { gain: 450 }])
	assert.deepEqual(props[2], [1, '-65280', { balance: 5000 }])
	assert.deepEqual(last('setFairlightAudioMixerSourceProps'), [1301, '-256', { framesDelay: 3 }])
	assert.equal(engine.resolve('in1')!.volumeDb, -6, 'echoed back')

	// mute = off; unmute puts back AFV
	const lap = engine.resolve('in2')!
	await engine.setMute(lap, true)
	await sleep(30)
	assert.deepEqual(last('setFairlightAudioMixerSourceProps'), [2, '-65280', { mixOption: 1 }])
	await engine.setMute(engine.resolve('in2')!, false)
	await sleep(30)
	assert.deepEqual(last('setFairlightAudioMixerSourceProps'), [2, '-65280', { mixOption: 4 }])
	assert.equal(engine.resolve('in2')!.mixOption, 'afv')

	// processing: EQ band, compressor, expander as a gate, make-up gain, master
	await engine.setBlockParam(cam, 'band3', 'gain', 3)
	await engine.setBlockParam(cam, 'band3', 'shape', 'notch')
	await engine.setBlockParam(cam, 'band3', 'q', 2.5)
	await engine.setBlockParam(cam, 'compressor', 'threshold', -20)
	await engine.setBlockParam(cam, 'compressor', 'makeUp', 4)
	await engine.setBlockParam(cam, 'expander', 'gate', 'gate')
	await engine.setBlockEnabled(cam, 'limiter', true)
	await engine.setBlockEnabled(cam, 'eq', true)
	await engine.setBlockParam(master, 'limiter', 'threshold', -3)
	engine.setVolume(master, -2)
	await engine.setMixOption(master, 'free')
	await sleep(30)
	const bands = atem.calledWith('setFairlightAudioMixerSourceEqualizerBandProps')
	assert.deepEqual(bands, [
		[1, '-65280', 2, { gain: 300 }],
		[1, '-65280', 2, { shape: 8 }],
		[1, '-65280', 2, { qFactor: 250 }],
	])
	assert.deepEqual(atem.calledWith('setFairlightAudioMixerSourceCompressorProps'), [[1, '-65280', { threshold: -2000 }]])
	assert.deepEqual(atem.calledWith('setFairlightAudioMixerSourceExpanderProps'), [[1, '-65280', { gateEnabled: true }]])
	assert.deepEqual(atem.calledWith('setFairlightAudioMixerSourceLimiterProps'), [[1, '-65280', { limiterEnabled: true }]])
	assert.ok(atem.calledWith('setFairlightAudioMixerSourceProps').some((p) => JSON.stringify(p) === JSON.stringify([1, '-65280', { makeUpGain: 400 }])))
	assert.deepEqual(atem.calledWith('setFairlightAudioMixerMasterLimiterProps'), [[{ threshold: -300 }]])
	assert.deepEqual(atem.calledWith('setFairlightAudioMixerMasterProps'), [[{ faderGain: -200 }], [{ followFadeToBlack: false }]])
	assert.equal(engine.resolve('in1')!.blocks.find((b) => b.id === 'expander')!.name, 'Gate', 'the expander is called a gate in gate mode')
	await engine.setBlockParam(cam, 'compressor', 'ratio', 'lots')
	assert.ok(logs.some((l) => l.includes("won't do")), 'impossible values are refused with a reason')

	// talkback and headphones
	await engine.setMute(engine.resolve('talkback')!, false)
	engine.setVolume(engine.resolve('talkback')!, -70)
	await sleep(30)
	assert.deepEqual(atem.calledWith('setFairlightAudioMixerMonitorProps'), [[{ inputTalkbackMuted: false }], [{ inputTalkbackGain: -6000 }]])

	// split to stereo: the two strips become one
	await device.setInputConfig('in1301.1', 'stereo')
	await until(() => !!engine.inputs.get('in1301'))
	assert.ok(!engine.inputs.has('in1301.1'))
	assert.equal(engine.resolve('in1301')!.name, 'Mic 1')

	// a change made on the ATEM itself
	atem.external((s) => (s.fairlight.inputs[1].sources['-65280'].properties.faderGain = -1200), ['fairlight.inputs.1.sources.-65280.properties'])
	await until(() => engine.resolve('in1')!.volumeDb === -12)

	// commands to a source that's gone are refused in plain words
	await assert.rejects(device.setVolume('in1301.1', -3), /hasn't got an input/)
	assert.ok(!logs.some((l) => l.startsWith('error')), logs.join('\n'))
})

test('Fairlight meters: dB×100 to the engine, gain reduction per block, re-asked after a reconnect', async (t) => {
	const { atem, engine } = rig(fairlightState)
	t.after(() => engine.destroy())
	atem.signal = { '1': -20, '2': null }
	await until(() => (engine.resolve('in1')?.postPeak.length ?? 0) > 0)
	await sleep(100)
	const cam = engine.resolve('in1')!
	assert.ok(Math.abs(cam.postPeak[0]! - -14) < 0.5, `post peak ${cam.postPeak[0]}`)
	assert.ok(Math.abs(cam.postMag[0]! - -20) < 0.5, `post level ${cam.postMag[0]}`)
	assert.ok(Math.abs(cam.prePeak[0]! - -14) < 0.5, `pre peak ${cam.prePeak[0]}`)
	assert.equal(cam.gainReduction.compressor, 3)
	assert.equal(cam.gainReduction.limiter, 0)
	assert.equal(engine.resolve('in2')!.postPeak[0], null, 'silence is -inf')
	assert.equal(engine.resolve('in1301.1')!.postPeak.length, 1, 'mono sources get one meter')
	assert.equal(engine.resolve('master')!.gainReduction.limiter, 1.5)
	const frame = engine.meterFrame()
	assert.equal(frame.in1[4].compressor, 3)

	const before = atem.calledWith('startFairlightMixerSendLevels').length
	atem.bounce()
	await until(() => atem.calledWith('startFairlightMixerSendLevels').length > before)
	await until(() => engine.connected && engine.visible().length === 9)
})

test('classic mixer: gain, balance, AFV, solo, no trim or processing, meters through our AMLv patch', async (t) => {
	const { atem, engine, device } = rig(classicState)
	t.after(() => engine.destroy())
	await until(() => engine.visible().length > 0)
	assert.equal(device.mixer, 'classic')
	assert.deepEqual(
		engine.visible().map((i) => i.id),
		['in1', 'in2', 'in3', 'in1001', 'in1002', 'master', 'monitor', 'phones', 'phones_prog', 'talkback', 'sidetone'],
	)
	assert.equal(engine.resolve('in1001')!.name, 'XLR 1')
	const cam = engine.resolve('in1')!
	assert.ok(!cam.caps.trim && !cam.caps.processing && !cam.caps.delay && !cam.caps.preMeter)
	assert.ok(cam.caps.monitor, 'solo, as the classic mixer has a monitor out')
	assert.equal(engine.resolve('in2')!.mixOption, 'afv')
	assert.equal(engine.resolve('in3')!.muted, true)
	assert.deepEqual(atem.calledWith('classicSendLevels'), [[true]])

	engine.setVolume(cam, -6)
	await engine.setBalance(cam, 0.25)
	await engine.setMixOption(cam, 'afv')
	await engine.monitoring.setPfl(cam, true)
	await sleep(40)
	const calls = atem.calledWith('setClassicAudioMixerInputProps')
	assert.deepEqual(calls[0], [1, { gain: -6 }])
	assert.deepEqual(calls[1], [1, { balance: -25 }])
	assert.deepEqual(calls[2], [1, { mixOption: 2 }])
	assert.deepEqual(atem.calledWith('setClassicAudioMixerMonitorProps'), [[{ solo: true, soloSource: 1 }]])
	assert.equal(engine.resolve('in1')!.volumeDb, -6, 'the ATEM rounds the gain; we show what we sent')
	assert.equal(engine.resolve('in1')!.monitor, 'solo')
	engine.setVolume(engine.resolve('master')!, -3)
	engine.setVolume(engine.resolve('talkback')!, -12)
	await sleep(30)
	assert.deepEqual(atem.calledWith('setClassicAudioMixerMasterProps'), [[{ gain: -3 }]])
	assert.deepEqual(atem.calledWith('setClassicAudioMixerHeadphonesProps'), [[{ talkbackGain: -12 }]])
	await device.setAfvCrossfade(false)
	assert.deepEqual(atem.calledWith('setClassicAudioMixerProps'), [[{ audioFollowVideo: false }]])
	await assert.rejects(device.setTrim('in1', 3), /isn't a Fairlight input/)

	// meters: post-fader only, as linear from the AMLv patch
	atem.signal = { '1001': -18 }
	await until(() => (engine.resolve('in1001')?.postPeak.length ?? 0) > 0)
	await sleep(120)
	const xlr = engine.resolve('in1001')!
	assert.ok(Math.abs(xlr.postMag[0]! - -18) < 0.5, `XLR level ${xlr.postMag[0]}`)
	assert.ok(Math.abs(xlr.postPeak[0]! - -12) < 0.5)
	assert.deepEqual(xlr.prePeak, [])
	assert.ok(Math.abs(engine.resolve('master')!.postMag[0]! - -15) < 0.1)
})

test('auto level through the engine: rides a Fairlight trim, and a classic fader', async (t) => {
	const f = rig(fairlightState)
	const c = rig(classicState)
	t.after(() => {
		f.engine.destroy()
		c.engine.destroy()
	})
	for (const { engine } of [f, c]) {
		engine.setDefaultSetting('measureWindowMs', 400)
		engine.setDefaultSetting('rideRateDbPerS', 12)
		engine.setDefaultSetting('captureMode', 'instant')
	}
	f.atem.signal = { '1': -24 }
	c.atem.signal = { '1001': -24 }
	await until(() => (f.engine.resolve('in1')?.postPeak.length ?? 0) > 0 && (c.engine.resolve('in1001')?.postPeak.length ?? 0) > 0)
	await sleep(600)

	// Fairlight, trim mode: the fader stays put
	f.engine.setInputSetting('in1', 'controlMode', 'trim')
	f.engine.setInputSetting('in1', 'autoLevelOn', true)
	await sleep(500)
	f.engine.captureTarget(f.engine.resolve('in1')!)
	assert.ok(Math.abs(f.engine.store.inputs.in1.target! - -24) < 1, `trim target (at the trim) ${f.engine.store.inputs.in1.target}`)
	f.atem.signal['1'] = -30
	await sleep(2200)
	const trim = f.atem.s.fairlight.inputs[1].sources['-65280'].properties
	assert.ok(trim.gain > 480 && trim.gain < 660, `ATEM trim ridden up ~6 dB: ${trim.gain}`)
	assert.equal(trim.faderGain, 0, 'fader left alone')

	// classic: no trim, so the gain (fader) is ridden
	c.engine.setInputSetting('in1001', 'autoLevelOn', true)
	c.engine.captureTarget(c.engine.resolve('in1001')!)
	assert.ok(Math.abs(c.engine.store.inputs.in1001.target! - -24) < 1, `classic target ${c.engine.store.inputs.in1001.target}`)
	c.atem.signal['1001'] = -30
	await sleep(2200)
	const g = c.atem.s.audio.channels[1001].gain
	assert.ok(g > 4.6 && g < 6.1, `classic gain ridden up ~6 dB: ${g}`)
})

test('recording and streaming on the ATEM: start, stop, file name, ISO, disk, state', async (t) => {
	const { atem, engine, device } = rig(fairlightState)
	t.after(() => engine.destroy())
	await until(() => engine.connected && engine.recorder.state.available)
	await engine.recorder.setFileName('Keynote '.repeat(40))
	const name = (atem.calledWith('setRecordingSettings')[0][0] as { filename: string }).filename
	assert.ok(Buffer.byteLength(name) <= 128, 'cut to the ATEM limit')
	await engine.recorder.start()
	await until(() => engine.recorder.state.active)
	assert.equal(device.extras().recording?.state, 'recording')
	assert.equal(device.extras().recording?.disk, 'SSD 1')
	assert.equal(device.extras().recording?.secondsLeft, 7200)
	await engine.recorder.stop()
	await until(() => !engine.recorder.state.active)
	await device.setIso(true)
	await device.setStreaming(true)
	await sleep(20)
	assert.equal(device.extras().recording?.iso, true)
	assert.equal(device.extras().streaming?.state, 'streaming')
	assert.deepEqual(
		atem.calls.map((c) => c.method).filter((m) => /Recording|Streaming|ISO/.test(m)),
		['setRecordingSettings', 'startRecording', 'stopRecording', 'setEnableISORecording', 'startStreaming'],
	)
	// the classic one can't record
	const c = rig(classicState)
	t.after(() => c.engine.destroy())
	await until(() => c.engine.connected)
	await c.engine.recorder.refresh()
	assert.equal(c.engine.recorder.state.available, false)
	await assert.rejects(c.device.setStreaming(true), /doesn't stream/)
})

test('recordings on the ATEM: the take is named from the sheet, renamed after stop, uploaded', async (t) => {
	const { existsSync, readdirSync } = await import('node:fs')
	const dir = mkdtempSync(join(tmpdir(), 'atem-rec-'))
	const atem = new FakeAtem(fairlightState)
	atem.writeTo = dir
	const sent: string[] = []
	const fake = { upload: async (job: { remoteFolder: string; remoteName: string }) => (sent.push(`${job.remoteFolder}/${job.remoteName}`), { remote: 'x' }) }
	const engine = new Engine(
		{ log: () => {}, save: () => {}, structureChanged: () => {}, stateChanged: () => {} },
		ATEM_INFO,
		{ ...atemEngineOptions(), sourceName: 'ATEM Main', recordings: { transports: { rclone: fake, share: fake, http: fake, webdav: fake } } },
		undefined,
		'',
	)
	t.after(() => engine.destroy())
	engine.useDevice(new AtemDevice({ host: '10.0.0.9', port: 9910, makeLink: () => atem, recordingsFolder: dir }))
	await until(() => engine.recorder.state.directory === dir)
	const r = engine.recordings
	r.configure({
		naming: { parts: ['Session', 'source'] },
		rename: { stablePollMs: 5, stableChecks: 1 },
		upload: { enabled: true, layout: 'fixed', folder: 'Shows', destinations: [{ id: 'd', kind: 'rclone', name: 'Drive', enabled: true, remote: 'gdrive:' } as never] },
	})
	r.loadSheetFile(new TextEncoder().encode('Session\nKeynote\nPanel\n'), 'rows.csv')
	r.setEnabled(true)
	await engine.recorder.start()
	await until(() => engine.recorder.state.active)
	assert.deepEqual(atem.calledWith('setRecordingSettings')[0], [{ filename: 'Keynote - ATEM Main' }], 'named from the row before the start')
	await until(() => atem.s.recording.properties.filename === 'ATEM')
	r.rowNext()
	await engine.recorder.stop()
	await until(() => existsSync(join(dir, 'Panel - ATEM Main.mp4')), 3000)
	assert.deepEqual(readdirSync(dir), ['Panel - ATEM Main.mp4'], 'renamed after stop (the row changed during the take)')
	await until(() => sent.length > 0, 3000)
	assert.deepEqual(sent, ['Shows/Panel - ATEM Main.mp4'])
})

test('connection errors in plain words', async (t) => {
	const atem = new FakeAtem(fairlightState)
	atem.reachable = false
	const d = new AtemDevice({ host: '10.9.9.9', port: 9910, makeLink: () => atem, unreachableMs: 50 })
	const said: string[] = []
	const host = { log: () => {}, connected: () => {}, disconnected: (r: string) => said.push(r), inputs: () => {}, inputAdded: () => {}, inputRemoved: () => {}, inputRenamed: () => {}, inputChanged: () => {}, meters: () => {}, record: () => {}, setting: () => undefined, version: () => {} }
	d.start(host)
	t.after(() => d.stop())
	assert.match(d.lastError, /Looking for the ATEM at 10\.9\.9\.9/)
	await sleep(100)
	assert.match(said.at(-1)!, /Can't reach the ATEM at 10\.9\.9\.9.*control slots/)
	const none = new AtemDevice({ host: ' ', port: 9910, makeLink: () => atem })
	none.start(host)
	assert.match(none.lastError, /No ATEM address yet/)
})

test('recordings folder: used only when this computer can read it, otherwise says why', async () => {
	assert.equal(await folderProblem(mkdtempSync(join(tmpdir(), 'atem-rec-'))), '')
	assert.match(await folderProblem('/nope/not/here'), /can't find the folder/)
	assert.match(await folderProblem('ftp://192.168.1.240/'), /FTP server.*as a drive/)
	assert.match(await folderProblem(''), /No recordings folder/)
	assert.match(await folderProblem(new URL(import.meta.url).pathname), /a file, not a folder/)
})

// ---- the Companion side --------------------------------------------------------------

/** A pretend Companion: just enough of the instance context to run the module */
function companion() {
	const calls: { fn: string; args: unknown[] }[] = []
	const logs: string[] = []
	;(globalThis as { COMPANION_LOGGER?: unknown }).COMPANION_LOGGER = (_s: string, level: string, m: string) => logs.push(`${level}: ${m}`)
	const ctx = new Proxy(
		{ _isInstanceContext: true, id: 'test', label: 'ATEM_Audio' } as Record<string | symbol, unknown>,
		{
			get: (o, k) => (k in o ? o[k] : (...args: unknown[]) => void calls.push({ fn: String(k), args })),
		},
	)
	const last = <T>(fn: string): T => calls.filter((c) => c.fn === fn).at(-1)?.args as T
	return { ctx, calls, logs, last }
}

const baseConfig = (over: Partial<Config> = {}): Config =>
	({ host: '10.0.0.9', port: '9910', webPort: '0', webBind: 'local', pin: '', varRateHz: '5', updateHours: '0', recFolder: '', gridBand: '', gridDwellMs: '', gridReleaseBand: '', gridReleaseMs: '', store: '', autosave: '', actionSaved: '', ...over }) as Config

test('Connection: set settings only changes ticked fields, and skips impossible values', async (t) => {
	const c = companion()
	const inst = new AtemAudioInstance(c.ctx as never)
	const atem = new FakeAtem(fairlightState)
	inst.makeLink = () => atem
	await inst.init(baseConfig())
	t.after(() => inst.destroy())
	await inst.configUpdated(baseConfig({ port_byAction: true, varRateHz_byAction: true, host_byAction: true } as Partial<Config>))
	const defs = () => c.last<[Record<string, { options: { id: string }[]; callback: (a: { options: Record<string, unknown> }) => Promise<void> }>]>('setActionDefinitions')[0]
	const act = defs().connection_set
	assert.deepEqual(
		act.options.map((o) => o.id),
		['host', 'port', 'varRateHz'],
	)
	await act.callback({ options: { port: '99999', varRateHz: '2.5', host: 'not an address' } })
	assert.ok(c.logs.some((l) => l.includes('needs a whole number from 1 to 65535') && l.includes('99999')))
	assert.ok(c.logs.some((l) => l.includes('from 1 to 20') && l.includes('2.5')))
	assert.ok(c.logs.some((l) => l.includes("can't be an ATEM address")))
	assert.equal(inst.config.port, '9910')
	await act.callback({ options: { port: '9911', webPort: '1234' } })
	assert.equal(inst.config.port, '9911')
	assert.equal(inst.config.webPort, '0', "not ticked, so it's left alone")
	assert.ok(c.logs.some((l) => l.includes("isn't ticked")))
	assert.equal(c.last<[Config]>('saveConfig')[0].port, '9911')
	// unticking puts back what was typed
	await inst.configUpdated(baseConfig({ port: '1', varRateHz_byAction: true, host_byAction: true } as Partial<Config>))
	assert.equal(inst.config.port, '9910')
	assert.deepEqual(UpgradeScripts, [])
})

test('presets, variables and feedbacks follow what the ATEM has', async (t) => {
	for (const [make, kind] of [
		[fairlightState, 'fairlight'],
		[classicState, 'classic'],
	] as const) {
		const c = companion()
		const inst = new AtemAudioInstance(c.ctx as never)
		const atem = new FakeAtem(make)
		inst.makeLink = () => atem
		await inst.init(baseConfig())
		t.after(() => inst.destroy())
		await until(() => inst.engine.visible().length > 0)
		await sleep(250)
		const [structure, presets] = c.last<[{ id: string; name: string; definitions: string[] }[], Record<string, unknown>]>('setPresetDefinitions')
		const ids = Object.keys(presets)
		for (const id of ['open_page', 'record', 'stream', 'afv_crossfade', 'ag_1', 'auto_level_1', 'mute_1', 'on_1', 'level_1', 'fader_up1_1']) assert.ok(ids.includes(id), `${kind}: preset ${id}`)
		const masterN = inst.engine.visible().findIndex((i) => i.id === 'master') + 1
		assert.ok(ids.includes(`ftb_${masterN}`), `${kind}: master follows FTB`)
		assert.ok(!ids.includes(`ag_${masterN}`), `${kind}: no auto gain button on the master`)
		assert.ok(structure.some((s) => s.name.includes('Bus') && s.name.includes('Master')))
		if (kind === 'fairlight') {
			for (const id of ['trim_up_1', 'pfl_1', 'solo_1', 'block_1_compressor', 'block_1_eq', 'afv_2', 'delay_up_3']) assert.ok(ids.includes(id), `fairlight: preset ${id}`)
			assert.ok(!ids.includes('delay_up_1'), 'HDMI has no delay')
			assert.ok(!ids.includes(`block_${masterN}_expander`))
		} else {
			assert.ok(!ids.some((id) => id.startsWith('trim_') || id.startsWith('block_')), 'classic: no trim or processing presets')
			assert.ok(ids.includes('dim'))
		}
		const vars = c.last<[Record<string, unknown>]>('setVariableDefinitions')[0]
		assert.ok('in1_auto_level' in vars && 'rec_remaining' in vars && 'atem_mixer' in vars)
		assert.equal('in1_compressor_threshold' in vars, kind === 'fairlight')
		const values = Object.assign({}, ...c.calls.filter((x) => x.fn === 'setVariableValues').map((x) => x.args[0]))
		assert.equal(values.atem_mixer, kind)
		assert.equal(values.in1_name, kind === 'fairlight' ? 'Presenter cam' : 'Presenter cam')
		const fbs = c.last<[Record<string, unknown>]>('setFeedbackDefinitions')[0]
		for (const id of ['auto_level_status', 'pickup_led', 'level_above', 'mix_option_is', 'block_on', 'recording', 'streaming', 'connected']) assert.ok(id in fbs, `feedback ${id}`)
		const statuses = c.calls.filter((x) => x.fn === 'updateStatus').map((x) => x.args[0])
		assert.equal(statuses.at(-1), 'ok')
	}
})

test('action recorder: changes made on the ATEM become actions', () => {
	assert.deepEqual(recordedAction({ kind: 'mixOption', input: 'in2', value: 'afv' }), { actionId: 'mix_option', options: { input: 'in2', value: 'afv' }, key: 'mix:in2' })
	assert.deepEqual(recordedAction({ kind: 'delay', input: 'in1301', value: 4 })?.options, { input: 'in1301', mode: 'set', value: '4' })
	const b = { id: 'band3', name: 'EQ band 3', kind: 'fl_eq_band', enabled: true, settings: {} }
	assert.deepEqual(recordedAction({ kind: 'blockParam', input: 'in1', block: b, key: 'gain', value: 3 })?.options, { input: 'in1', param: 'fl_eq_band:gain', band: '3', mode: 'set', value: '3' })
	assert.equal(recordedAction({ kind: 'volume', input: 'in1', db: null })?.options.db, '-inf')
})

test('help and manifest: the notice, the name, the right ids', () => {
	const help = readFileSync(join(process.cwd(), 'companion/HELP.md'), 'utf8')
	const manifest = JSON.parse(readFileSync(join(process.cwd(), 'companion/manifest.json'), 'utf8'))
	assert.ok(
		help.includes(
			"Psst. This one's got mates. 🍹\n\nATEM Audio is part of a little crew of Companion modules: some brand new, some old favourites given a good tweak. Want to know who else is in the crew, or grab the freshest version of each one? It's all here:",
		),
	)
	assert.ok(help.includes('https://github.com/nisted/companion-modules'))
	assert.equal(manifest.id, 'atem-audio')
	assert.equal(manifest.shortname, 'ATEM Audio')
	assert.equal(manifest.manufacturer, 'Blackmagic Design')
	assert.deepEqual(manifest.products, ['ATEM Audio'])
	assert.equal(manifest.runtime.permissions['worker-threads'], true)
})

test('meters: if the ATEM stops sending them, ask again until they come back', async (t) => {
	const { atem, engine, logs } = rig(fairlightState, undefined, 200)
	t.after(() => engine.destroy())
	atem.signal = { '1': -20 }
	await until(() => engine.connected && atem.levelsOn)
	await sleep(300)
	const asks = atem.calledWith('startFairlightMixerSendLevels').length
	assert.equal(asks, 1, 'no extra asks while meters flow')
	atem.levelsOn = false // the ATEM goes quiet on its own
	await until(() => atem.calledWith('startFairlightMixerSendLevels').length > asks)
	assert.ok(atem.calledWith('stopFairlightMixerSendLevels').length >= 1, 'off then on')
	await until(() => logs.some((l) => l.includes('meters are back')))
	assert.equal(logs.filter((l) => l.includes('went quiet')).length, 1, 'said once')
})
