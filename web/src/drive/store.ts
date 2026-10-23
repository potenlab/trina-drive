// What the folder on screen lets the frame do, and "something changed" signals between the Files page and the
// sidebar's folder tree (a move dropped on the tree reloads the list; an upload or rename in the list reloads the tree).
import { useSyncExternalStore } from 'react'

export interface Here { path: string; writable: boolean; managed: boolean; files: boolean }
let here: Here = { path: '/', writable: false, managed: false, files: false }
const listeners = new Set<() => void>()
const emit = () => listeners.forEach((f) => f())
const sub = (f: () => void) => { listeners.add(f); return () => { listeners.delete(f) } }

export function setHere(h: Partial<Here>) {
  const n = { ...here, ...h }
  if (n.path === here.path && n.writable === here.writable && n.managed === here.managed && n.files === here.files) return
  here = n
  emit()
}
export const useHere = (): Here => useSyncExternalStore(sub, () => here)

type NewHandler = (x: number, y: number) => void
let onNew: NewHandler | null = null
/** Files registers its "+ New" menu; the sidebar button opens it. */
export function handleNew(f: NewHandler | null) { onNew = f }
export function openNew(x: number, y: number) { onNew?.(x, y) }

function channel() {
  const fs = new Set<(folder: string) => void>()
  return { on: (f: (folder: string) => void) => { fs.add(f); return () => { fs.delete(f) } }, send: (folder: string) => fs.forEach((f) => f(folder)) }
}
/** The tree changed a folder (a drop): Files reloads when it shows that folder. */
export const filesChanged = channel()
/** Files changed something: the tree reloads its open branches. */
export const treeStale = channel()
