import os
import sqlite3
import uuid
from datetime import datetime, timezone
from functools import wraps

from flask import (
    Flask, request, jsonify, render_template, redirect,
    url_for, session, send_from_directory, Response
)
from werkzeug.utils import secure_filename

import config

BASE_DIR = os.path.dirname(os.path.abspath(__file__))
UPLOAD_DIR = os.path.join(BASE_DIR, "uploads")
DB_PATH = os.path.join(BASE_DIR, "tickets.db")
ALLOWED_EXT = {"jpg", "jpeg", "png", "webp"}
MIME_BY_EXT = {"jpg": "image/jpeg", "jpeg": "image/jpeg", "png": "image/png", "webp": "image/webp"}

# ---------------------------------------------------------------------------
# Deux modes de stockage :
#  - Postgres (variable d'environnement DATABASE_URL présente, ex. sur Render)
#    -> les photos sont stockées directement dans la base, pas de disque
#       nécessaire : les données survivent aux redéploiements.
#  - SQLite + fichiers locaux (par défaut, ex. en local ou sur PythonAnywhere)
#    -> simple, aucune base externe à configurer.
# ---------------------------------------------------------------------------
DATABASE_URL = os.environ.get("DATABASE_URL")
USE_PG = bool(DATABASE_URL)

if USE_PG:
    import psycopg2
    import psycopg2.extras
else:
    os.makedirs(UPLOAD_DIR, exist_ok=True)

app = Flask(__name__)
app.secret_key = os.environ.get("SECRET_KEY", config.SECRET_KEY)
app.config["MAX_CONTENT_LENGTH"] = 8 * 1024 * 1024  # 8 Mo par requête

ADMIN_USERNAME = os.environ.get("ADMIN_USERNAME", config.ADMIN_USERNAME)
ADMIN_PASSWORD = os.environ.get("ADMIN_PASSWORD", config.ADMIN_PASSWORD)


def get_conn():
    if USE_PG:
        conn = psycopg2.connect(DATABASE_URL, sslmode="require")
        return conn
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    return conn


def init_db():
    conn = get_conn()
    if USE_PG:
        cur = conn.cursor()
        cur.execute(
            """
            CREATE TABLE IF NOT EXISTS tickets (
                id TEXT PRIMARY KEY,
                technicien TEXT NOT NULL,
                montant NUMERIC NOT NULL,
                date TEXT NOT NULL,
                categorie TEXT NOT NULL,
                note TEXT,
                photo_data BYTEA NOT NULL,
                photo_mime TEXT NOT NULL,
                status TEXT NOT NULL DEFAULT 'en_attente',
                admin_note TEXT,
                created_at TEXT NOT NULL
            )
            """
        )
        conn.commit()
        cur.close()
    else:
        conn.execute(
            """
            CREATE TABLE IF NOT EXISTS tickets (
                id TEXT PRIMARY KEY,
                technicien TEXT NOT NULL,
                montant REAL NOT NULL,
                date TEXT NOT NULL,
                categorie TEXT NOT NULL,
                note TEXT,
                photo_filename TEXT NOT NULL,
                status TEXT NOT NULL DEFAULT 'en_attente',
                admin_note TEXT,
                created_at TEXT NOT NULL
            )
            """
        )
        conn.commit()
    conn.close()


init_db()


def login_required(f):
    @wraps(f)
    def wrapper(*args, **kwargs):
        if not session.get("is_admin"):
            return jsonify({"error": "unauthorized"}), 401
        return f(*args, **kwargs)
    return wrapper


def allowed_file(filename):
    return "." in filename and filename.rsplit(".", 1)[1].lower() in ALLOWED_EXT


def row_to_dict(r):
    return {
        "id": r["id"],
        "technicien": r["technicien"],
        "montant": float(r["montant"]),
        "date": r["date"],
        "categorie": r["categorie"],
        "note": r["note"],
        "photo_url": url_for("serve_photo", ticket_id=r["id"]),
        "status": r["status"],
        "admin_note": r["admin_note"],
        "created_at": r["created_at"],
    }


# ---------------------------------------------------------------------------
# Espace technicien (public, pas d'accès admin depuis cette interface)
# ---------------------------------------------------------------------------

@app.route("/")
def index():
    return render_template("index.html")


@app.route("/api/tickets", methods=["POST"])
def create_ticket():
    technicien = (request.form.get("technicien") or "").strip()
    montant_raw = request.form.get("montant")
    date = request.form.get("date")
    categorie = request.form.get("categorie")
    note = (request.form.get("note") or "").strip()
    photo = request.files.get("photo")

    if not technicien or not montant_raw or not date or not categorie or not photo:
        return jsonify({"error": "Champs manquants."}), 400

    try:
        montant = round(float(montant_raw), 2)
    except (TypeError, ValueError):
        return jsonify({"error": "Montant invalide."}), 400
    if montant <= 0:
        return jsonify({"error": "Montant invalide."}), 400

    if photo.filename == "" or not allowed_file(photo.filename):
        return jsonify({"error": "Format de photo non supporté."}), 400

    ext = photo.filename.rsplit(".", 1)[1].lower()
    mime = MIME_BY_EXT[ext]
    ticket_id = uuid.uuid4().hex
    created_at = datetime.now(timezone.utc).isoformat()

    conn = get_conn()
    if USE_PG:
        photo_bytes = photo.read()
        cur = conn.cursor()
        cur.execute(
            "INSERT INTO tickets "
            "(id, technicien, montant, date, categorie, note, photo_data, photo_mime, status, created_at) "
            "VALUES (%s, %s, %s, %s, %s, %s, %s, %s, 'en_attente', %s)",
            (ticket_id, technicien, montant, date, categorie, note,
             psycopg2.Binary(photo_bytes), mime, created_at),
        )
        conn.commit()
        cur.close()
    else:
        filename = secure_filename(f"{ticket_id}.{ext}")
        photo.save(os.path.join(UPLOAD_DIR, filename))
        conn.execute(
            "INSERT INTO tickets "
            "(id, technicien, montant, date, categorie, note, photo_filename, status, created_at) "
            "VALUES (?, ?, ?, ?, ?, ?, ?, 'en_attente', ?)",
            (ticket_id, technicien, montant, date, categorie, note, filename, created_at),
        )
        conn.commit()
    conn.close()
    return jsonify({"id": ticket_id}), 201


@app.route("/api/tickets")
def list_my_tickets():
    technicien = (request.args.get("technicien") or "").strip()
    if not technicien:
        return jsonify([])
    conn = get_conn()
    if USE_PG:
        cur = conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor)
        cur.execute(
            "SELECT id, technicien, montant, date, categorie, note, status, admin_note, created_at "
            "FROM tickets WHERE lower(technicien) = lower(%s) ORDER BY created_at DESC",
            (technicien,),
        )
        rows = cur.fetchall()
        cur.close()
    else:
        rows = conn.execute(
            "SELECT * FROM tickets WHERE lower(technicien) = lower(?) ORDER BY created_at DESC",
            (technicien,),
        ).fetchall()
    conn.close()
    return jsonify([row_to_dict(r) for r in rows])


@app.route("/photos/<ticket_id>")
def serve_photo(ticket_id):
    conn = get_conn()
    if USE_PG:
        cur = conn.cursor()
        cur.execute("SELECT photo_data, photo_mime FROM tickets WHERE id = %s", (ticket_id,))
        row = cur.fetchone()
        cur.close()
        conn.close()
        if not row:
            return "", 404
        photo_data, photo_mime = row
        return Response(bytes(photo_data), mimetype=photo_mime)
    else:
        row = conn.execute("SELECT photo_filename FROM tickets WHERE id = ?", (ticket_id,)).fetchone()
        conn.close()
        if not row:
            return "", 404
        return send_from_directory(UPLOAD_DIR, row["photo_filename"])


# ---------------------------------------------------------------------------
# Espace admin (protégé par identifiant / mot de passe)
# ---------------------------------------------------------------------------

@app.route("/admin")
def admin_home():
    if not session.get("is_admin"):
        return redirect(url_for("admin_login"))
    return render_template("admin.html")


@app.route("/admin/login", methods=["GET", "POST"])
def admin_login():
    error = None
    if request.method == "POST":
        username = request.form.get("username", "")
        password = request.form.get("password", "")
        if username == ADMIN_USERNAME and password == ADMIN_PASSWORD:
            session["is_admin"] = True
            return redirect(url_for("admin_home"))
        error = "Identifiant ou mot de passe incorrect."
    return render_template("admin_login.html", error=error)


@app.route("/admin/logout")
def admin_logout():
    session.pop("is_admin", None)
    return redirect(url_for("admin_login"))


@app.route("/api/admin/tickets")
@login_required
def list_all_tickets():
    conn = get_conn()
    if USE_PG:
        cur = conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor)
        cur.execute(
            "SELECT id, technicien, montant, date, categorie, note, status, admin_note, created_at "
            "FROM tickets ORDER BY created_at DESC"
        )
        rows = cur.fetchall()
        cur.close()
    else:
        rows = conn.execute("SELECT * FROM tickets ORDER BY created_at DESC").fetchall()
    conn.close()
    return jsonify([row_to_dict(r) for r in rows])


@app.route("/api/admin/tickets/<ticket_id>/status", methods=["POST"])
@login_required
def update_ticket_status(ticket_id):
    data = request.get_json(force=True, silent=True) or {}
    status = data.get("status")
    admin_note = data.get("admin_note", "")
    if status not in ("en_attente", "valide", "rejete"):
        return jsonify({"error": "Statut invalide."}), 400
    conn = get_conn()
    if USE_PG:
        cur = conn.cursor()
        cur.execute(
            "UPDATE tickets SET status = %s, admin_note = %s WHERE id = %s",
            (status, admin_note, ticket_id),
        )
        conn.commit()
        cur.close()
    else:
        conn.execute(
            "UPDATE tickets SET status = ?, admin_note = ? WHERE id = ?",
            (status, admin_note, ticket_id),
        )
        conn.commit()
    conn.close()
    return jsonify({"ok": True})


if __name__ == "__main__":
    app.run(debug=True, host="0.0.0.0", port=int(os.environ.get("PORT", 5000)))
