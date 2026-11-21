import { PDFDocument, StandardFonts, rgb } from 'pdf-lib'
import { writeFile } from 'node:fs/promises'

const document = await PDFDocument.create()
document.setTitle('PaperFlow PDF Selection Sample')
document.setAuthor('PaperFlow')
document.setSubject('Original sample document for PDF.js selection and highlight testing')
const regular = await document.embedFont(StandardFonts.Helvetica)
const bold = await document.embedFont(StandardFonts.HelveticaBold)
const blue = rgb(0.259, 0.388, 0.651)
const dark = rgb(0.13, 0.17, 0.23)
const muted = rgb(0.43, 0.48, 0.56)

const pages = [
  {
    heading: 'Reading is where research begins',
    subtitle: 'An original sample for testing text selection and highlights',
    sections: [
      ['ABSTRACT', 'Research grows through small, connected moments of curiosity. A reader may\nunderline a sentence, write a note, and return to it after discussing an idea.\nThis sample contains selectable text for testing the PaperFlow PDF reader.'],
      ['01  A PLACE TO THINK', 'A useful reading tool should help people focus on the source. It should also\nmake it easy to return to the evidence behind a thought. Select this sentence\nand save a highlight to test whether it remains aligned after zooming.'],
      ['02  CAPTURING CONTEXT', 'A highlight is more meaningful when its page and position are preserved.\nThe selected words provide context, while normalized rectangles describe\ntheir location on the page. Try selecting multiple lines in this paragraph.'],
      ['A NOTE ON THIS DOCUMENT', 'This document was created for PaperFlow as a technical test fixture.\nIts text is original and may be used to test selection, paging, and zooming.'],
    ],
  },
  {
    heading: 'A second page for exploration',
    subtitle: 'Page navigation and restoration test',
    sections: [
      ['03  RETURNING TO AN IDEA', 'Research is rarely a straight line. Readers return to earlier pages as new\nquestions emerge. Save a highlight on this page, move to the first page,\nthen come back to see whether the highlight is restored in the right place.'],
      ['04  WORKING WITH EVIDENCE', 'A reliable note should point back to the original source and preserve its\ncontext. Coordinates can restore a visual highlight for the same PDF, but\nchanged documents and scanned pages require different anchoring methods.'],
      ['05  BUILDING TOGETHER', 'Shared understanding starts with clear references and thoughtful questions.\nThis demonstration runs locally and does not store a paper on a server.'],
    ],
  },
]

pages.forEach((content, index) => {
  const page = document.addPage([612, 792])
  page.drawRectangle({ x: 0, y: 770, width: 612, height: 22, color: blue })
  page.drawText('PAPERFLOW  /  READING LAB', { x: 64, y: 728, size: 9, font: bold, color: blue })
  page.drawText(`SAMPLE 0${index + 1}`, { x: 475, y: 728, size: 9, font: regular, color: muted })
  page.drawText(content.heading, { x: 64, y: 675, size: 23, font: bold, color: dark })
  page.drawText(content.subtitle, { x: 64, y: 651, size: 11, font: regular, color: muted })
  page.drawLine({ start: { x: 64, y: 629 }, end: { x: 548, y: 629 }, thickness: 0.8, color: rgb(0.87, 0.89, 0.92) })
  let y = 600
  for (const [title, text] of content.sections) {
    page.drawText(title, { x: 64, y, size: 10, font: bold, color: blue })
    y -= 23
    for (const line of text.split('\n')) {
      page.drawText(line, { x: 64, y, size: 11, font: regular, color: dark })
      y -= 18
    }
    y -= 25
  }
  page.drawLine({ start: { x: 64, y: 55 }, end: { x: 548, y: 55 }, thickness: 0.8, color: rgb(0.87, 0.89, 0.92) })
  page.drawText('PAPERFLOW  /  ORIGINAL DEMONSTRATION DOCUMENT', { x: 64, y: 36, size: 8, font: regular, color: muted })
  page.drawText(String(index + 1), { x: 540, y: 36, size: 9, font: regular, color: muted })
})

await writeFile(new URL('../public/paperflow-sample.pdf', import.meta.url), await document.save())
