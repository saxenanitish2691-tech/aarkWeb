Store brochure PDF files in this folder.

How it works:
1. Put your PDF in this folder or a subfolder inside it.
2. Open brochures/manifest.json
3. Map the property id to the PDF file path.

Example:
{
  "1": {
    "file": "sample/dlf-camellias.pdf",
    "downloadName": "dlf-camellias-brochure.pdf"
  },
  "2": {
    "file": "gygy-mentis.pdf"
  }
}

If a property does not have a mapped PDF here, the server will generate a simple brochure PDF automatically.
