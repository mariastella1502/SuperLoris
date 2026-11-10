"""Backend minimale per il sito di compleanno di Loris.
Avvio:  python app.py   ->  http://localhost:8000
Non richiede librerie esterne (solo Python standard).
"""
import json
from http.server import HTTPServer, SimpleHTTPRequestHandler

AUGURI = {
    "per": "Loris",
    "eta": 27,
    "data": "2026-11-12",
    "da": "Stella",
    "messaggio": ("Buon 27esimo compleanno amore! Che questo livello della tua vita "
                  "sia pieno di magia, viaggi, musica e tante vittorie. "
                  "La tua Principessa Stella ti aspetta al castello. 💛")
}

class Handler(SimpleHTTPRequestHandler):
    def do_GET(self):
        if self.path == "/api/auguri":
            body = json.dumps(AUGURI, ensure_ascii=False).encode("utf-8")
            self.send_response(200)
            self.send_header("Content-Type", "application/json; charset=utf-8")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)
        else:
            super().do_GET()

if __name__ == "__main__":
    print("🎂 Sito compleanno Loris su http://localhost:8000")
    HTTPServer(("0.0.0.0", 8000), Handler).serve_forever()