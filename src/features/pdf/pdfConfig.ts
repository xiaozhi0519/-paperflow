import { GlobalWorkerOptions, TextLayer } from 'pdfjs-dist'
import workerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url'

// Canvas/TextLayer only: never attach a scripting manager or execute PDF actions.
GlobalWorkerOptions.workerSrc = workerUrl
// Keep PDF.js canvas and DOM text measurements on the same base fonts.
TextLayer.fontFamilyMap.set('sans-serif', 'Arial, sans-serif')
TextLayer.fontFamilyMap.set('serif', '"Times New Roman", serif')
TextLayer.fontFamilyMap.set('monospace', '"Courier New", monospace')
