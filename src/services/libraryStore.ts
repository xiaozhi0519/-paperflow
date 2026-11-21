import { indexedDbLibrary } from './indexedDbLibrary'
import { remoteLibrary } from './remoteLibrary'

export const storageMode = localStorage.getItem('paperflow-storage-mode') === 'remote' ? 'remote' : 'local'
export const libraryStore = storageMode === 'remote' ? remoteLibrary : indexedDbLibrary
export function setStorageMode(mode: 'local' | 'remote', target = '/library') {
  localStorage.setItem('paperflow-storage-mode', mode)
  window.location.assign(target)
}
