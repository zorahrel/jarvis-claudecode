// ocr-vision — OCR con il framework Vision di Apple.
//
// Perche' non tesseract: Vision e' addestrato su testo reale (schermi, foto,
// scritte storte) mentre tesseract nasce per scansioni di documenti puliti. Su
// uno screenshot con testo antialiasato tesseract sbaglia caratteri che Vision
// prende. E' gia' installato su ogni Mac: zero dipendenze, zero rete, zero costo.
//
// Uso:
//   ocr-vision <immagine>            testo in ordine di lettura
//   ocr-vision <immagine> --json     ogni riga con bounding box e confidenza
//   ocr-vision <immagine> --fast     modello veloce (meno preciso)
//
// Le bbox sono normalizzate 0-1 con ORIGINE IN ALTO A SINISTRA, come tutto il
// resto del mondo: Vision le restituisce con origine in basso, e la conversione
// e' fatta qui una volta per tutte invece che in ogni chiamante.

import Foundation
import Vision
import CoreGraphics
import ImageIO

struct Line: Codable {
    let text: String
    let confidence: Float
    let x: Double
    let y: Double
    let width: Double
    let height: Double
}

func fail(_ msg: String) -> Never {
    FileHandle.standardError.write(("ocr-vision: " + msg + "\n").data(using: .utf8)!)
    exit(1)
}

let args = CommandLine.arguments.dropFirst()
guard let path = args.first(where: { !$0.hasPrefix("--") }) else {
    fail("uso: ocr-vision <immagine> [--json] [--fast] [--lang it,en]")
}
let wantJSON = args.contains("--json")
let fast = args.contains("--fast")

var langs = ["it-IT", "en-US"]
if let i = args.firstIndex(of: "--lang"), args.indices.contains(i + 1) {
    langs = args[i + 1].split(separator: ",").map {
        let s = String($0)
        // "it" e "en" sono le forme che uno scrive a mano; Vision vuole il tag
        // completo e con quello corto non fallisce: ignora la lingua in silenzio.
        return s.contains("-") ? s : (s == "it" ? "it-IT" : s == "en" ? "en-US" : s)
    }
}

let url = URL(fileURLWithPath: path)
guard FileManager.default.fileExists(atPath: url.path) else { fail("file non trovato: \(path)") }
guard let src = CGImageSourceCreateWithURL(url as CFURL, nil),
      let cgImage = CGImageSourceCreateImageAtIndex(src, 0, nil) else {
    fail("non riesco a leggere l'immagine: \(path)")
}

let request = VNRecognizeTextRequest()
request.recognitionLevel = fast ? .fast : .accurate
request.usesLanguageCorrection = true
request.recognitionLanguages = langs

let handler = VNImageRequestHandler(cgImage: cgImage, options: [:])
do {
    try handler.perform([request])
} catch {
    fail("Vision ha fallito: \(error.localizedDescription)")
}

guard let observations = request.results else {
    if wantJSON { print("[]") }
    exit(0)
}

var lines: [Line] = []
for obs in observations {
    guard let cand = obs.topCandidates(1).first else { continue }
    let b = obs.boundingBox
    lines.append(Line(
        text: cand.string,
        confidence: cand.confidence,
        x: Double(b.origin.x),
        // Vision ha l'origine in basso a sinistra: 1 - (y + altezza) la porta
        // in alto a sinistra, cosi' e' confrontabile con moondream e col DOM.
        y: Double(1 - b.origin.y - b.height),
        width: Double(b.width),
        height: Double(b.height)
    ))
}

// Ordine di lettura: dall'alto in basso, poi da sinistra a destra. Vision
// restituisce le righe in ordine di confidenza, che su una fattura o una
// dashboard produce testo a caso.
lines.sort { a, b in
    if abs(a.y - b.y) > 0.01 { return a.y < b.y }
    return a.x < b.x
}

if wantJSON {
    let enc = JSONEncoder()
    enc.outputFormatting = [.prettyPrinted, .sortedKeys]
    let data = try! enc.encode(lines)
    print(String(data: data, encoding: .utf8)!)
} else {
    for l in lines { print(l.text) }
}
