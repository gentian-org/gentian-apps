/**
 * Frontend extension registry — the UI half of customization ladder rung L3.
 *
 * A plugin contributes UI by registering components against *named slots* the app
 * declares. Slot names are public API: renaming or removing one is a breaking
 * change to every plugin using it, and follows the same versioning policy as the
 * backend contract (see backend/app/extensions/api.py).
 *
 * Plugin bundles are loaded at runtime from the app's static root, so adding UI
 * does not require rebuilding the app image. See
 * gentian-os/docs/app-customization.md.
 */

import type { ComponentType } from 'react'

/** Semver of the frontend extension contract. Additive changes bump the minor. */
export const EXTENSION_API_VERSION = '1.0.0'

/** Majors this app still loads plugins for (N-2). */
export const SUPPORTED_MAJOR_VERSIONS = [1]

/**
 * Slots this app exposes.
 *
 * Declare every slot here rather than letting plugins invent names: an
 * undeclared slot is an undocumented extension point, which is how a plugin ends
 * up coupled to internals that were never promised.
 */
export type SlotName =
  | 'dashboard.widgets'
  | 'nav.primary'
  | 'settings.sections'
  | 'item.actions'

export interface SlotContext {
  tenant?: string
  [key: string]: unknown
}

export interface SlotContribution {
  /** Stable id, unique within the slot. Used as the React key. */
  id: string
  /** Lower sorts first. Ties break on id so ordering is deterministic. */
  order?: number
  component: ComponentType<{ context: SlotContext }>
}

export interface ExtensionManifest {
  name: string
  apiVersion: string
  /** Contributions keyed by slot name. */
  slots: Partial<Record<SlotName, SlotContribution[]>>
}

const registry = new Map<SlotName, SlotContribution[]>()
const loaded: string[] = []
const failed: Record<string, string> = {}

function majorOf(version: string): number {
  return Number.parseInt(version.split('.', 1)[0] ?? '', 10)
}

/**
 * Register one plugin's contributions.
 *
 * Version-incompatible plugins are refused outright rather than partially
 * applied — a half-registered plugin produces UI that fails in ways nobody can
 * trace back to its source.
 */
export function register(manifest: ExtensionManifest): void {
  if (!SUPPORTED_MAJOR_VERSIONS.includes(majorOf(manifest.apiVersion))) {
    failed[manifest.name] =
      `targets extension API ${manifest.apiVersion}, supported majors: ${SUPPORTED_MAJOR_VERSIONS.join(', ')}`
    return
  }

  for (const [slot, contributions] of Object.entries(manifest.slots)) {
    if (!contributions) continue
    const existing = registry.get(slot as SlotName) ?? []
    registry.set(slot as SlotName, [...existing, ...contributions])
  }
  loaded.push(manifest.name)
}

/** Contributions for a slot, in deterministic order. */
export function contributionsFor(slot: SlotName): SlotContribution[] {
  return [...(registry.get(slot) ?? [])].sort(
    (a, b) => (a.order ?? 100) - (b.order ?? 100) || a.id.localeCompare(b.id),
  )
}

/** What loaded and what did not — mirrors the backend diagnostics endpoint. */
export function registryState() {
  return { apiVersion: EXTENSION_API_VERSION, loaded: [...loaded], failed: { ...failed } }
}

/**
 * Load plugin bundles listed in the runtime manifest.
 *
 * Failures are recorded and skipped: one broken plugin must degrade to a missing
 * widget, never to a blank application.
 */
export async function loadExtensions(manifestUrl = '/extensions/manifest.json'): Promise<void> {
  let entries: { name: string; module: string }[]
  try {
    const response = await fetch(manifestUrl)
    if (!response.ok) return // no plugins installed is the normal case
    entries = await response.json()
  } catch {
    return
  }

  await Promise.all(
    entries.map(async (entry) => {
      try {
        const module = await import(/* @vite-ignore */ entry.module)
        const manifest: ExtensionManifest = module.default ?? module.manifest
        if (!manifest) throw new Error('bundle exports no manifest')
        register(manifest)
      } catch (error) {
        failed[entry.name] = String(error)
      }
    }),
  )
}
