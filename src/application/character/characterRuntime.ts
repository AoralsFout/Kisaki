export type CharacterRenderKind = 'illustration' | 'live2d'

export interface CharacterLook {
  emotion: string
  stance: string
  costume: string
  screenPose: string
}

export interface CharacterCapabilities {
  emotions: readonly string[]
  stances: readonly string[]
  costumes: readonly string[]
}

export interface CharacterSelection {
  id: string
  render: CharacterRenderKind
  capabilities: CharacterCapabilities
  defaults: CharacterLook
}

export interface CharacterRuntimeSnapshot {
  characterId: string | null
  render: CharacterRenderKind | null
  look: CharacterLook | null
  capabilities: CharacterCapabilities | null
  revision: number
}

export interface CharacterRenderer {
  apply(snapshot: CharacterRuntimeSnapshot): void | Promise<void>
  dispose?(): void | Promise<void>
}

interface RendererSlot {
  renderer: CharacterRenderer
  tail: Promise<void>
}

type RuntimeListener = (snapshot: CharacterRuntimeSnapshot) => void

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T
}

function assertSupported(value: string, supported: readonly string[], field: string): void {
  if (!supported.includes(value)) throw new Error(`Unsupported ${field}: ${value}`)
}

/**
 * Framework-independent owner of the active character and visual state.
 * Commands update state even when no renderer is attached; a newly attached
 * renderer immediately receives the latest complete snapshot.
 */
export class CharacterRuntime {
  private state: CharacterRuntimeSnapshot = {
    characterId: null,
    render: null,
    look: null,
    capabilities: null,
    revision: 0,
  }

  private readonly renderers = new Map<CharacterRenderKind, RendererSlot>()
  private readonly listeners = new Set<RuntimeListener>()

  constructor(private readonly onRendererError: (error: unknown) => void = () => {}) {}

  snapshot(): CharacterRuntimeSnapshot {
    return clone(this.state)
  }

  selectCharacter(selection: CharacterSelection): void {
    if (!selection.id.trim()) throw new Error('Character id must not be empty')
    this.assertLook(selection.defaults, selection.capabilities)
    this.state = {
      characterId: selection.id,
      render: selection.render,
      look: clone(selection.defaults),
      capabilities: clone(selection.capabilities),
      revision: this.state.revision + 1,
    }
    this.publish()
  }

  setLook(change: Partial<CharacterLook>): void {
    if (!this.state.look || !this.state.capabilities) throw new Error('No character is selected')
    const next = { ...this.state.look, ...change }
    this.assertLook(next, this.state.capabilities)
    if (
      next.emotion === this.state.look.emotion
      && next.stance === this.state.look.stance
      && next.costume === this.state.look.costume
      && next.screenPose === this.state.look.screenPose
    ) return
    this.state.look = next
    this.state.revision++
    this.publish()
  }

  attachRenderer(kind: CharacterRenderKind, renderer: CharacterRenderer): () => void {
    const previous = this.renderers.get(kind)
    if (previous) void previous.tail.then(() => previous.renderer.dispose?.()).catch(this.onRendererError)

    const slot: RendererSlot = { renderer, tail: Promise.resolve() }
    this.renderers.set(kind, slot)
    if (this.state.render === kind && this.state.characterId) this.enqueueRender(slot, this.snapshot())

    return () => {
      if (this.renderers.get(kind) !== slot) return
      this.renderers.delete(kind)
      void slot.tail.then(() => renderer.dispose?.()).catch(this.onRendererError)
    }
  }

  subscribe(listener: RuntimeListener): () => void {
    this.listeners.add(listener)
    listener(this.snapshot())
    return () => this.listeners.delete(listener)
  }

  async whenRendererSettled(kind: CharacterRenderKind): Promise<void> {
    await this.renderers.get(kind)?.tail
  }

  private publish(): void {
    const snapshot = this.snapshot()
    for (const listener of this.listeners) listener(clone(snapshot))
    if (!this.state.render) return
    const slot = this.renderers.get(this.state.render)
    if (slot) this.enqueueRender(slot, snapshot)
  }

  private enqueueRender(slot: RendererSlot, snapshot: CharacterRuntimeSnapshot): void {
    slot.tail = slot.tail
      .then(() => slot.renderer.apply(clone(snapshot)))
      .catch(this.onRendererError)
  }

  private assertLook(look: CharacterLook, capabilities: CharacterCapabilities): void {
    assertSupported(look.emotion, capabilities.emotions, 'emotion')
    assertSupported(look.stance, capabilities.stances, 'stance')
    assertSupported(look.costume, capabilities.costumes, 'costume')
    if (!look.screenPose.trim()) throw new Error('Screen pose must not be empty')
  }
}
