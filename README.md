# TraceDesk PDF Editor (PC)

Edit any PDF, including scanned and photo PDFs, without changing its layout:
- Edit text: click a line already on the page and type. The old words are covered in the page's own
  background colour and the new words go in the same place, size, colour and weight.
- Add text, Pen / sign, White-out, Highlight, Tick, Cross. Undo (Ctrl+Z), Save (Ctrl+S), zoom.
- Saving makes a new copy ("name_edited.pdf"); the original file is never changed.
- Files stay on the computer: nothing is uploaded. Works offline after the first visit.

## Put it online once (free, GitHub Pages)
1. On github.com create a new repository, e.g. "pdf-editor" (Public).
2. Click "uploading an existing file" and drag ALL the files and folders from this zip
   (index.html, app.js, sw.js, manifest.webmanifest, the two icons and the "lib" folder). Commit.
3. Settings > Pages > Source: "Deploy from a branch", Branch: main, folder: / (root) > Save.
4. After 1-2 minutes the editor is at: https://YOUR-GITHUB-NAME.github.io/pdf-editor/

## Install on each PC (Windows, Chrome or Edge)
1. Open the link above in Chrome or Edge.
2. Click "Install on this PC" (top right), or the install icon in the address bar.
3. It gets its own desktop / Start menu icon and opens in its own window, like a normal program.
   It can also be chosen in "Open with" for PDF files.

Libraries included: PDF.js (Apache-2.0), pdf-lib (MIT), Tesseract.js (Apache-2.0) with English text data.
