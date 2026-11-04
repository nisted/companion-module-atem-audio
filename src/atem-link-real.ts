/**
 * The real AtemLink: one atem-connection Atem, plus our classic-levels hook.
 * About as thin as it gets; everything clever is in atem-device.ts.
 */

import { EventEmitter } from 'node:events'
import { Atem, Commands, type AtemState } from 'atem-connection'
import type { AtemCalls, AtemLink, AtemLinkEvents } from './atem-link.js'
import { ClassicLevelsUpdateCommand, ClassicSendLevelsCommand, hookClassicLevels } from './classic-levels.js'

export class RealAtemLink extends EventEmitter<AtemLinkEvents> implements AtemLink {
	readonly #atem = new Atem()
	readonly classicLevels: boolean
	#connected = false

	constructor() {
		super()
		this.classicLevels = hookClassicLevels(this.#atem)
		this.#atem.on('connected', () => {
			this.#connected = true
			this.emit('connected')
		})
		this.#atem.on('disconnected', () => {
			this.#connected = false
			this.emit('disconnected')
		})
		this.#atem.on('stateChanged', (state, paths) => this.emit('state', state, paths))
		this.#atem.on('levelChanged', (l) => this.emit('levels', l))
		this.#atem.on('receivedCommands', (cmds) => {
			for (const c of cmds) if (c instanceof ClassicLevelsUpdateCommand) this.emit('levels', c.properties)
		})
		this.#atem.on('error', (m) => this.emit('error', String(m)))
		this.#atem.on('info', (m) => this.emit('info', String(m)))
	}

	get state(): Readonly<AtemState> | undefined {
		return this.#atem.state
	}

	get connected(): boolean {
		return this.#connected
	}

	connect(host: string, port: number): void {
		this.#atem.connect(host, port).catch((e: unknown) => this.emit('error', `Couldn't start connecting: ${(e as Error)?.message ?? e}`))
	}

	async destroy(): Promise<void> {
		this.removeAllListeners()
		try {
			await this.#atem.disconnect()
		} catch {
			/* already gone */
		}
		await this.#atem.destroy().catch(() => undefined)
	}

	async call<K extends keyof AtemCalls>(method: K, ...args: AtemCalls[K]): Promise<void> {
		if (method === 'setFairlightAudioFollowVideoCrossfade') {
			const cmd = new Commands.FairlightMixerMasterPropertiesCommand()
			cmd.updateProps({ audioFollowVideo: !!args[0] })
			return this.#atem.sendCommand(cmd)
		}
		if (method === 'classicSendLevels') return this.#atem.sendCommand(new ClassicSendLevelsCommand(!!args[0]))
		const fn = (this.#atem as unknown as Record<string, (...a: unknown[]) => Promise<void>>)[method]
		if (typeof fn !== 'function') throw new Error(`The ATEM library hasn't got ${method}`)
		return fn.apply(this.#atem, args)
	}
}
