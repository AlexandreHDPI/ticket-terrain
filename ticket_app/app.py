import hashlib
import json
import os
import re
import sqlite3
import time
import uuid
from datetime import datetime, timezone
from functools import wraps
from zoneinfo import ZoneInfo

from flask import (
    Flask, request, jsonify, render_template, redirect,
    url_for, session, send_from_directory, Response
)
from werkzeug.utils import secure_filename

import config

try:
    from pywebpush import webpush, WebPushException
except ImportError:  # pragma: no cover - garde-fou si le paquet manque en local
    webpush = None
    class WebPushException(Exception):
        pass

BASE_DIR = os.path.dirname(os.path.abspath(__file__))
UPLOAD_DIR = os.path.join(BASE_DIR, "uploads")
DB_PATH = os.path.join(BASE_DIR, "tickets.db")
ALLOWED_EXT = {"jpg", "jpeg", "png", "webp"}
MIME_BY_EXT = {"jpg": "image/jpeg", "jpeg": "image/jpeg", "png": "image/png", "webp": "image/webp"}
EDITABLE_STATUSES = ("en_attente",)
CARD_LAST4_RE = re.compile(r"^\d{4}$")

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
# Cookies de session sécurisés : Secure dès qu'on tourne derrière HTTPS (Render
# fournit HTTPS en frontal), SameSite=Lax pour limiter les envois cross-site.
app.config["SESSION_COOKIE_SAMESITE"] = "Lax"
app.config["SESSION_COOKIE_SECURE"] = bool(os.environ.get("RENDER") or USE_PG)
app.config["SESSION_COOKIE_HTTPONLY"] = True

ADMIN_USERNAME = os.environ.get("ADMIN_USERNAME", config.ADMIN_USERNAME)
ADMIN_PASSWORD = os.environ.get("ADMIN_PASSWORD", config.ADMIN_PASSWORD)

# ---------------------------------------------------------------------------
# Notifications push (rappel hebdomadaire du vendredi matin). Clés VAPID
# générées une fois puis stockées en variables d'environnement sur Render.
# Sans ces variables, les endpoints push répondent simplement "non configuré"
# sans jamais faire planter le reste de l'application.
# ---------------------------------------------------------------------------
VAPID_PRIVATE_KEY = os.environ.get("VAPID_PRIVATE_KEY")
VAPID_PUBLIC_KEY = os.environ.get("VAPID_PUBLIC_KEY")
VAPID_CONTACT_EMAIL = os.environ.get("VAPID_CONTACT_EMAIL", "mailto:alexandre@hdpi.fr")
CRON_SECRET = os.environ.get("CRON_SECRET")
PARIS_TZ = ZoneInfo("Europe/Paris")

# ---------------------------------------------------------------------------
# Anti-brute-force simple sur la connexion admin : blocage temporaire par IP
# après plusieurs échecs. En mémoire (suffisant pour une seule instance).
# ---------------------------------------------------------------------------
LOGIN_MAX_ATTEMPTS = 5
LOGIN_LOCKOUT_SECONDS = 300
_login_attempts = {}


def _client_ip():
    return (request.headers.get("X-Forwarded-For", "") or request.remote_addr or "?").split(",")[0].strip()


def _login_blocked():
    entry = _login_attempts.get(_client_ip())
    if not entry:
        return False
    count, first_fail = entry
    if count < LOGIN_MAX_ATTEMPTS:
        return False
    if time.time() - first_fail > LOGIN_LOCKOUT_SECONDS:
        _login_attempts.pop(_client_ip(), None)
        return False
    return True


def _register_login_failure():
    ip = _client_ip()
    count, first_fail = _login_attempts.get(ip, (0, time.time()))
    if time.time() - first_fail > LOGIN_LOCKOUT_SECONDS:
        count, first_fail = 0, time.time()
    _login_attempts[ip] = (count + 1, first_fail)


def _clear_login_failures():
    _login_attempts.pop(_client_ip(), None)


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
                photo_data BYTEA,
                photo_mime TEXT,
                pending_receipt BOOLEAN NOT NULL DEFAULT FALSE,
                status TEXT NOT NULL DEFAULT 'en_attente',
                admin_note TEXT,
                created_at TEXT NOT NULL,
                updated_at TEXT,
                lat DOUBLE PRECISION,
                lng DOUBLE PRECISION,
                location_label TEXT,
                card_last4 TEXT
            )
            """
        )
        # Migrations douces pour les bases créées avant l'ajout de ces colonnes.
        for stmt in (
            "ALTER TABLE tickets ADD COLUMN IF NOT EXISTS pending_receipt BOOLEAN NOT NULL DEFAULT FALSE",
            "ALTER TABLE tickets ADD COLUMN IF NOT EXISTS updated_at TEXT",
            "ALTER TABLE tickets ALTER COLUMN photo_data DROP NOT NULL",
            "ALTER TABLE tickets ALTER COLUMN photo_mime DROP NOT NULL",
            "ALTER TABLE tickets ADD COLUMN IF NOT EXISTS lat DOUBLE PRECISION",
            "ALTER TABLE tickets ADD COLUMN IF NOT EXISTS lng DOUBLE PRECISION",
            "ALTER TABLE tickets ADD COLUMN IF NOT EXISTS location_label TEXT",
            "ALTER TABLE tickets ADD COLUMN IF NOT EXISTS card_last4 TEXT",
        ):
            try:
                cur.execute(stmt)
            except Exception:
                conn.rollback()
        cur.execute(
            """
            CREATE TABLE IF NOT EXISTS push_subscriptions (
                id TEXT PRIMARY KEY,
                technicien TEXT,
                endpoint TEXT UNIQUE NOT NULL,
                p256dh TEXT NOT NULL,
                auth TEXT NOT NULL,
                created_at TEXT NOT NULL
            )
            """
        )
        cur.execute(
            """
            CREATE TABLE IF NOT EXISTS app_state (
                key TEXT PRIMARY KEY,
                value TEXT
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
                photo_filename TEXT,
                pending_receipt INTEGER NOT NULL DEFAULT 0,
                status TEXT NOT NULL DEFAULT 'en_attente',
                admin_note TEXT,
                created_at TEXT NOT NULL,
                updated_at TEXT,
                lat REAL,
                lng REAL,
                location_label TEXT,
                card_last4 TEXT
            )
            """
        )
        existing_cols = {row["name"] for row in conn.execute("PRAGMA table_info(tickets)").fetchall()}
        if "pending_receipt" not in existing_cols:
            conn.execute("ALTER TABLE tickets ADD COLUMN pending_receipt INTEGER NOT NULL DEFAULT 0")
        if "updated_at" not in existing_cols:
            conn.execute("ALTER TABLE tickets ADD COLUMN updated_at TEXT")
        if "lat" not in existing_cols:
            conn.execute("ALTER TABLE tickets ADD COLUMN lat REAL")
        if "lng" not in existing_cols:
            conn.execute("ALTER TABLE tickets ADD COLUMN lng REAL")
        if "location_label" not in existing_cols:
            conn.execute("ALTER TABLE tickets ADD COLUMN location_label TEXT")
        if "card_last4" not in existing_cols:
            conn.execute("ALTER TABLE tickets ADD COLUMN card_last4 TEXT")
        conn.execute(
            """
            CREATE TABLE IF NOT EXISTS push_subscriptions (
                id TEXT PRIMARY KEY,
                technicien TEXT,
                endpoint TEXT UNIQUE NOT NULL,
                p256dh TEXT NOT NULL,
                auth TEXT NOT NULL,
                created_at TEXT NOT NULL
            )
            """
        )
        conn.execute(
            """
            CREATE TABLE IF NOT EXISTS app_state (
                key TEXT PRIMARY KEY,
                value TEXT
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
    has_photo = bool(r["photo_data"]) if USE_PG else bool(r["photo_filename"])
    lat = r["lat"] if "lat" in r.keys() else None
    lng = r["lng"] if "lng" in r.keys() else None
    return {
        "id": r["id"],
        "technicien": r["technicien"],
        "montant": float(r["montant"]),
        "date": r["date"],
        "categorie": r["categorie"],
        "note": r["note"],
        "photo_url": url_for("serve_photo", ticket_id=r["id"]) if has_photo else None,
        "pending_receipt": bool(r["pending_receipt"]),
        "status": r["status"],
        "admin_note": r["admin_note"],
        "created_at": r["created_at"],
        "updated_at": r["updated_at"],
        "lat": float(lat) if lat is not None else None,
        "lng": float(lng) if lng is not None else None,
        "location_label": r["location_label"] if "location_label" in r.keys() else None,
        "card_last4": r["card_last4"] if "card_last4" in r.keys() else None,
    }


def get_ticket_row(conn, ticket_id):
    if USE_PG:
        cur = conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor)
        cur.execute("SELECT * FROM tickets WHERE id = %s", (ticket_id,))
        row = cur.fetchone()
        cur.close()
        return row
    return conn.execute("SELECT * FROM tickets WHERE id = ?", (ticket_id,)).fetchone()


def parse_bool(value):
    return str(value).strip().lower() in ("1", "true", "on", "yes")


def parse_coord(value):
    if value is None or str(value).strip() == "":
        return None
    try:
        return float(value)
    except (TypeError, ValueError):
        return None


# ---------------------------------------------------------------------------
# Notifications push : abonnements des technicien·nes + rappel automatique
# du vendredi matin (« pensez à rentrer vos tickets »).
# ---------------------------------------------------------------------------

def _get_app_state(conn, key):
    if USE_PG:
        cur = conn.cursor()
        cur.execute("SELECT value FROM app_state WHERE key = %s", (key,))
        row = cur.fetchone()
        cur.close()
        return row[0] if row else None
    row = conn.execute("SELECT value FROM app_state WHERE key = ?", (key,)).fetchone()
    return row["value"] if row else None


def _set_app_state(conn, key, value):
    if USE_PG:
        cur = conn.cursor()
        cur.execute(
            "INSERT INTO app_state (key, value) VALUES (%s, %s) "
            "ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value",
            (key, value),
        )
        conn.commit()
        cur.close()
    else:
        conn.execute(
            "INSERT INTO app_state (key, value) VALUES (?, ?) "
            "ON CONFLICT(key) DO UPDATE SET value = excluded.value",
            (key, value),
        )
        conn.commit()


def _remove_push_subscription(conn, endpoint):
    if USE_PG:
        cur = conn.cursor()
        cur.execute("DELETE FROM push_subscriptions WHERE endpoint = %s", (endpoint,))
        conn.commit()
        cur.close()
    else:
        conn.execute("DELETE FROM push_subscriptions WHERE endpoint = ?", (endpoint,))
        conn.commit()


def send_push_notification(title, body):
    """Envoie une notification push à tous les technicien·nes abonné·es.
    Retire automatiquement les abonnements devenus invalides (404/410,
    ex. application désinstallée ou notifications désactivées)."""
    if not VAPID_PRIVATE_KEY or not VAPID_PUBLIC_KEY or webpush is None:
        return {"sent": 0, "removed": 0, "total": 0, "error": "push_non_configure"}

    conn = get_conn()
    if USE_PG:
        cur = conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor)
        cur.execute("SELECT * FROM push_subscriptions")
        subs = cur.fetchall()
        cur.close()
    else:
        subs = conn.execute("SELECT * FROM push_subscriptions").fetchall()

    sent, removed = 0, 0
    payload = json.dumps({"title": title, "body": body})
    for s in subs:
        subscription_info = {
            "endpoint": s["endpoint"],
            "keys": {"p256dh": s["p256dh"], "auth": s["auth"]},
        }
        try:
            webpush(
                subscription_info=subscription_info,
                data=payload,
                vapid_private_key=VAPID_PRIVATE_KEY,
                vapid_claims={"sub": VAPID_CONTACT_EMAIL},
            )
            sent += 1
        except WebPushException as exc:
            status = getattr(exc.response, "status_code", None) if getattr(exc, "response", None) is not None else None
            if status in (404, 410):
                removed += 1
                _remove_push_subscription(conn, s["endpoint"])
        except Exception:
            pass  # un abonné en erreur ne doit jamais bloquer les autres envois

    conn.close()
    return {"sent": sent, "removed": removed, "total": len(subs)}


def maybe_send_friday_reminder(force=False):
    """Envoie le rappel du vendredi matin (8h30, heure de Paris) si on est
    dans la bonne fenêtre et qu'il n'a pas déjà été envoyé aujourd'hui.
    Utilise l'heure locale réelle de Paris (via zoneinfo) plutôt qu'un
    horaire UTC fixe : reste juste même lors des changements d'heure."""
    now_paris = datetime.now(PARIS_TZ)
    if not force:
        if now_paris.weekday() != 4:  # 4 = vendredi
            return {"skipped": "not_friday"}
        if not (now_paris.hour == 8 and 25 <= now_paris.minute < 50):
            return {"skipped": "outside_window"}

    today_str = now_paris.date().isoformat()
    conn = get_conn()
    if not force:
        last_sent = _get_app_state(conn, "last_friday_reminder")
        if last_sent == today_str:
            conn.close()
            return {"skipped": "already_sent_today"}
    _set_app_state(conn, "last_friday_reminder", today_str)
    conn.close()

    result = send_push_notification(
        "Rappel HDPI — Tickets Terrain",
        "N'oubliez pas de rentrer vos tickets de frais de la semaine !",
    )
    return {"triggered_at": now_paris.isoformat(), **result}


# ---------------------------------------------------------------------------
# Espace technicien (public, pas d'accès admin depuis cette interface)
# ---------------------------------------------------------------------------

@app.route("/")
def index():
    return render_template("index.html")


@app.route("/sw.js")
def service_worker():
    resp = send_from_directory(os.path.join(BASE_DIR, "static"), "sw.js")
    resp.headers["Service-Worker-Allowed"] = "/"
    resp.headers["Cache-Control"] = "no-cache"
    return resp


@app.route("/api/tickets", methods=["POST"])
def create_ticket():
    technicien = (request.form.get("technicien") or "").strip()
    montant_raw = request.form.get("montant")
    date = request.form.get("date")
    categorie = request.form.get("categorie")
    note = (request.form.get("note") or "").strip()
    pending_receipt = parse_bool(request.form.get("pending_receipt"))
    lat = parse_coord(request.form.get("lat"))
    lng = parse_coord(request.form.get("lng"))
    location_label = (request.form.get("location_label") or "").strip() or None
    card_last4 = (request.form.get("card_last4") or "").strip()
    photo = request.files.get("photo")
    has_photo = bool(photo and photo.filename)

    if not technicien or not montant_raw or not date or not categorie:
        return jsonify({"error": "Champs manquants."}), 400
    if not has_photo and not pending_receipt:
        return jsonify({"error": "Ajoutez une photo, ou cochez « justificatif en attente »."}), 400
    if not CARD_LAST4_RE.match(card_last4):
        return jsonify({"error": "Indiquez les 4 derniers chiffres de la carte bancaire utilisée."}), 400

    try:
        montant = round(float(montant_raw), 2)
    except (TypeError, ValueError):
        return jsonify({"error": "Montant invalide."}), 400
    if montant <= 0:
        return jsonify({"error": "Montant invalide."}), 400

    if has_photo and not allowed_file(photo.filename):
        return jsonify({"error": "Format de photo non supporté."}), 400

    ticket_id = uuid.uuid4().hex
    created_at = datetime.now(timezone.utc).isoformat()

    conn = get_conn()
    if USE_PG:
        photo_bytes = None
        mime = None
        if has_photo:
            ext = photo.filename.rsplit(".", 1)[1].lower()
            mime = MIME_BY_EXT[ext]
            photo_bytes = psycopg2.Binary(photo.read())
        cur = conn.cursor()
        cur.execute(
            "INSERT INTO tickets "
            "(id, technicien, montant, date, categorie, note, photo_data, photo_mime, "
            "pending_receipt, status, created_at, lat, lng, location_label, card_last4) "
            "VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, 'en_attente', %s, %s, %s, %s, %s)",
            (ticket_id, technicien, montant, date, categorie, note,
             photo_bytes, mime, pending_receipt, created_at, lat, lng, location_label, card_last4),
        )
        conn.commit()
        cur.close()
    else:
        filename = None
        if has_photo:
            ext = photo.filename.rsplit(".", 1)[1].lower()
            filename = secure_filename(f"{ticket_id}.{ext}")
            photo.save(os.path.join(UPLOAD_DIR, filename))
        conn.execute(
            "INSERT INTO tickets "
            "(id, technicien, montant, date, categorie, note, photo_filename, "
            "pending_receipt, status, created_at, lat, lng, location_label, card_last4) "
            "VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'en_attente', ?, ?, ?, ?, ?)",
            (ticket_id, technicien, montant, date, categorie, note, filename,
             1 if pending_receipt else 0, created_at, lat, lng, location_label, card_last4),
        )
        conn.commit()
    conn.close()
    return jsonify({"id": ticket_id}), 201


@app.route("/api/tickets/<ticket_id>", methods=["PUT"])
def update_my_ticket(ticket_id):
    conn = get_conn()
    row = get_ticket_row(conn, ticket_id)
    if not row:
        conn.close()
        return jsonify({"error": "Ticket introuvable."}), 404

    technicien = (request.form.get("technicien") or "").strip()
    if not technicien or technicien.lower() != (row["technicien"] or "").strip().lower():
        conn.close()
        return jsonify({"error": "Vous ne pouvez modifier que vos propres tickets."}), 403
    if row["status"] not in EDITABLE_STATUSES:
        conn.close()
        return jsonify({"error": "Ce ticket a déjà été traité par l'admin, il n'est plus modifiable."}), 409

    montant_raw = request.form.get("montant")
    date = request.form.get("date")
    categorie = request.form.get("categorie")
    note = (request.form.get("note") or "").strip()
    pending_receipt = parse_bool(request.form.get("pending_receipt"))
    card_last4 = (request.form.get("card_last4") or "").strip()
    photo = request.files.get("photo")
    has_new_photo = bool(photo and photo.filename)

    if not montant_raw or not date or not categorie:
        conn.close()
        return jsonify({"error": "Champs manquants."}), 400
    if not CARD_LAST4_RE.match(card_last4):
        conn.close()
        return jsonify({"error": "Indiquez les 4 derniers chiffres de la carte bancaire utilisée."}), 400
    try:
        montant = round(float(montant_raw), 2)
    except (TypeError, ValueError):
        conn.close()
        return jsonify({"error": "Montant invalide."}), 400
    if montant <= 0:
        conn.close()
        return jsonify({"error": "Montant invalide."}), 400

    keeps_existing_photo = bool(row["photo_data"]) if USE_PG else bool(row["photo_filename"])
    if not has_new_photo and not keeps_existing_photo and not pending_receipt:
        conn.close()
        return jsonify({"error": "Ajoutez une photo, ou cochez « justificatif en attente »."}), 400
    if has_new_photo and not allowed_file(photo.filename):
        conn.close()
        return jsonify({"error": "Format de photo non supporté."}), 400

    updated_at = datetime.now(timezone.utc).isoformat()

    if USE_PG:
        cur = conn.cursor()
        if has_new_photo:
            ext = photo.filename.rsplit(".", 1)[1].lower()
            mime = MIME_BY_EXT[ext]
            photo_bytes = psycopg2.Binary(photo.read())
            cur.execute(
                "UPDATE tickets SET montant=%s, date=%s, categorie=%s, note=%s, pending_receipt=%s, "
                "photo_data=%s, photo_mime=%s, updated_at=%s, card_last4=%s WHERE id=%s",
                (montant, date, categorie, note, pending_receipt, photo_bytes, mime, updated_at, card_last4, ticket_id),
            )
        else:
            cur.execute(
                "UPDATE tickets SET montant=%s, date=%s, categorie=%s, note=%s, pending_receipt=%s, "
                "updated_at=%s, card_last4=%s WHERE id=%s",
                (montant, date, categorie, note, pending_receipt, updated_at, card_last4, ticket_id),
            )
        conn.commit()
        cur.close()
    else:
        if has_new_photo:
            ext = photo.filename.rsplit(".", 1)[1].lower()
            filename = secure_filename(f"{ticket_id}-{uuid.uuid4().hex[:8]}.{ext}")
            photo.save(os.path.join(UPLOAD_DIR, filename))
            old_filename = row["photo_filename"]
            conn.execute(
                "UPDATE tickets SET montant=?, date=?, categorie=?, note=?, pending_receipt=?, "
                "photo_filename=?, updated_at=?, card_last4=? WHERE id=?",
                (montant, date, categorie, note, 1 if pending_receipt else 0, filename, updated_at, card_last4, ticket_id),
            )
            conn.commit()
            if old_filename:
                try:
                    os.remove(os.path.join(UPLOAD_DIR, old_filename))
                except OSError:
                    pass
        else:
            conn.execute(
                "UPDATE tickets SET montant=?, date=?, categorie=?, note=?, pending_receipt=?, "
                "updated_at=?, card_last4=? WHERE id=?",
                (montant, date, categorie, note, 1 if pending_receipt else 0, updated_at, card_last4, ticket_id),
            )
            conn.commit()
    conn.close()
    return jsonify({"ok": True})


@app.route("/api/tickets/<ticket_id>", methods=["DELETE"])
def delete_my_ticket(ticket_id):
    technicien = (request.args.get("technicien") or "").strip()
    conn = get_conn()
    row = get_ticket_row(conn, ticket_id)
    if not row:
        conn.close()
        return jsonify({"error": "Ticket introuvable."}), 404
    if not technicien or technicien.lower() != (row["technicien"] or "").strip().lower():
        conn.close()
        return jsonify({"error": "Vous ne pouvez supprimer que vos propres tickets."}), 403
    if row["status"] not in EDITABLE_STATUSES:
        conn.close()
        return jsonify({"error": "Ce ticket a déjà été traité par l'admin, il n'est plus modifiable."}), 409

    if USE_PG:
        cur = conn.cursor()
        cur.execute("DELETE FROM tickets WHERE id = %s", (ticket_id,))
        conn.commit()
        cur.close()
    else:
        filename = row["photo_filename"]
        conn.execute("DELETE FROM tickets WHERE id = ?", (ticket_id,))
        conn.commit()
        if filename:
            try:
                os.remove(os.path.join(UPLOAD_DIR, filename))
            except OSError:
                pass
    conn.close()
    return jsonify({"ok": True})


@app.route("/api/tickets")
def list_my_tickets():
    technicien = (request.args.get("technicien") or "").strip()
    if not technicien:
        return jsonify([])
    conn = get_conn()
    if USE_PG:
        cur = conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor)
        cur.execute(
            "SELECT id, technicien, montant, date, categorie, note, photo_data, "
            "pending_receipt, status, admin_note, created_at, updated_at, lat, lng, location_label, card_last4 "
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


@app.route("/api/technicians")
def list_technicians():
    conn = get_conn()
    if USE_PG:
        cur = conn.cursor()
        cur.execute("SELECT DISTINCT technicien FROM tickets ORDER BY technicien")
        names = [r[0] for r in cur.fetchall()]
        cur.close()
    else:
        rows = conn.execute("SELECT DISTINCT technicien FROM tickets ORDER BY technicien").fetchall()
        names = [r["technicien"] for r in rows]
    conn.close()
    return jsonify([n for n in names if n])


@app.route("/api/push/vapid-public-key")
def push_vapid_public_key():
    return jsonify({"publicKey": VAPID_PUBLIC_KEY or ""})


@app.route("/api/push/subscribe", methods=["POST"])
def push_subscribe():
    data = request.get_json(force=True, silent=True) or {}
    sub = data.get("subscription") or {}
    endpoint = sub.get("endpoint")
    keys = sub.get("keys") or {}
    p256dh = keys.get("p256dh")
    auth = keys.get("auth")
    technicien = (data.get("technicien") or "").strip() or None
    if not endpoint or not p256dh or not auth:
        return jsonify({"error": "Abonnement invalide."}), 400

    sub_id = hashlib.sha256(endpoint.encode("utf-8")).hexdigest()
    created_at = datetime.now(timezone.utc).isoformat()
    conn = get_conn()
    if USE_PG:
        cur = conn.cursor()
        cur.execute(
            "INSERT INTO push_subscriptions (id, technicien, endpoint, p256dh, auth, created_at) "
            "VALUES (%s, %s, %s, %s, %s, %s) "
            "ON CONFLICT (endpoint) DO UPDATE SET technicien = EXCLUDED.technicien, "
            "p256dh = EXCLUDED.p256dh, auth = EXCLUDED.auth",
            (sub_id, technicien, endpoint, p256dh, auth, created_at),
        )
        conn.commit()
        cur.close()
    else:
        conn.execute(
            "INSERT INTO push_subscriptions (id, technicien, endpoint, p256dh, auth, created_at) "
            "VALUES (?, ?, ?, ?, ?, ?) "
            "ON CONFLICT(endpoint) DO UPDATE SET technicien = excluded.technicien, "
            "p256dh = excluded.p256dh, auth = excluded.auth",
            (sub_id, technicien, endpoint, p256dh, auth, created_at),
        )
        conn.commit()
    conn.close()
    return jsonify({"ok": True})


@app.route("/api/push/unsubscribe", methods=["POST"])
def push_unsubscribe():
    data = request.get_json(force=True, silent=True) or {}
    endpoint = data.get("endpoint")
    if not endpoint:
        return jsonify({"error": "endpoint manquant."}), 400
    conn = get_conn()
    _remove_push_subscription(conn, endpoint)
    conn.close()
    return jsonify({"ok": True})


@app.route("/api/push/cron-trigger", methods=["POST"])
def push_cron_trigger():
    """Appelé par la tâche planifiée Render chaque vendredi matin. Protégé
    par un secret partagé (jamais par la session admin, ce n'est pas un
    navigateur qui appelle cette route)."""
    if not CRON_SECRET or request.headers.get("X-Cron-Secret") != CRON_SECRET:
        return jsonify({"error": "unauthorized"}), 401
    result = maybe_send_friday_reminder()
    return jsonify(result)


@app.route("/api/admin/push/test", methods=["POST"])
@login_required
def push_admin_test():
    """Permet à l'admin d'envoyer un rappel de test à tous les abonnés,
    pour vérifier que tout fonctionne sans attendre vendredi."""
    result = send_push_notification(
        "Test — Tickets Terrain",
        "Ceci est une notification de test envoyée depuis l'espace admin.",
    )
    return jsonify(result)


@app.route("/photos/<ticket_id>")
def serve_photo(ticket_id):
    conn = get_conn()
    if USE_PG:
        cur = conn.cursor()
        cur.execute("SELECT photo_data, photo_mime FROM tickets WHERE id = %s", (ticket_id,))
        row = cur.fetchone()
        cur.close()
        conn.close()
        if not row or not row[0]:
            return "", 404
        photo_data, photo_mime = row
        return Response(bytes(photo_data), mimetype=photo_mime)
    else:
        row = conn.execute("SELECT photo_filename FROM tickets WHERE id = ?", (ticket_id,)).fetchone()
        conn.close()
        if not row or not row["photo_filename"]:
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
        if _login_blocked():
            error = "Trop de tentatives. Réessayez dans quelques minutes."
        else:
            username = request.form.get("username", "")
            password = request.form.get("password", "")
            if username == ADMIN_USERNAME and password == ADMIN_PASSWORD:
                _clear_login_failures()
                session["is_admin"] = True
                return redirect(url_for("admin_home"))
            _register_login_failure()
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
            "SELECT id, technicien, montant, date, categorie, note, photo_data, "
            "pending_receipt, status, admin_note, created_at, updated_at, lat, lng, location_label, card_last4 "
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


@app.route("/api/admin/tickets/<ticket_id>", methods=["PUT"])
@login_required
def admin_update_ticket(ticket_id):
    conn = get_conn()
    row = get_ticket_row(conn, ticket_id)
    if not row:
        conn.close()
        return jsonify({"error": "Ticket introuvable."}), 404

    technicien = (request.form.get("technicien") or row["technicien"] or "").strip()
    montant_raw = request.form.get("montant")
    date = request.form.get("date")
    categorie = request.form.get("categorie")
    note = request.form.get("note")
    note = row["note"] if note is None else note.strip()
    pending_raw = request.form.get("pending_receipt")
    pending_receipt = parse_bool(pending_raw) if pending_raw is not None else bool(row["pending_receipt"])
    card_last4_raw = request.form.get("card_last4")
    card_last4 = row["card_last4"] if card_last4_raw is None else (card_last4_raw.strip() or None)
    photo = request.files.get("photo")
    has_new_photo = bool(photo and photo.filename)

    if not technicien or not montant_raw or not date or not categorie:
        conn.close()
        return jsonify({"error": "Champs manquants."}), 400
    if card_last4 and not CARD_LAST4_RE.match(card_last4):
        conn.close()
        return jsonify({"error": "Les 4 derniers chiffres de la carte doivent être 4 chiffres."}), 400
    try:
        montant = round(float(montant_raw), 2)
    except (TypeError, ValueError):
        conn.close()
        return jsonify({"error": "Montant invalide."}), 400
    if montant <= 0:
        conn.close()
        return jsonify({"error": "Montant invalide."}), 400
    if has_new_photo and not allowed_file(photo.filename):
        conn.close()
        return jsonify({"error": "Format de photo non supporté."}), 400

    updated_at = datetime.now(timezone.utc).isoformat()

    if USE_PG:
        cur = conn.cursor()
        if has_new_photo:
            ext = photo.filename.rsplit(".", 1)[1].lower()
            mime = MIME_BY_EXT[ext]
            photo_bytes = psycopg2.Binary(photo.read())
            cur.execute(
                "UPDATE tickets SET technicien=%s, montant=%s, date=%s, categorie=%s, note=%s, "
                "pending_receipt=%s, photo_data=%s, photo_mime=%s, updated_at=%s, card_last4=%s WHERE id=%s",
                (technicien, montant, date, categorie, note, pending_receipt, photo_bytes, mime, updated_at, card_last4, ticket_id),
            )
        else:
            cur.execute(
                "UPDATE tickets SET technicien=%s, montant=%s, date=%s, categorie=%s, note=%s, "
                "pending_receipt=%s, updated_at=%s, card_last4=%s WHERE id=%s",
                (technicien, montant, date, categorie, note, pending_receipt, updated_at, card_last4, ticket_id),
            )
        conn.commit()
        cur.close()
    else:
        if has_new_photo:
            ext = photo.filename.rsplit(".", 1)[1].lower()
            filename = secure_filename(f"{ticket_id}-{uuid.uuid4().hex[:8]}.{ext}")
            photo.save(os.path.join(UPLOAD_DIR, filename))
            old_filename = row["photo_filename"]
            conn.execute(
                "UPDATE tickets SET technicien=?, montant=?, date=?, categorie=?, note=?, "
                "pending_receipt=?, photo_filename=?, updated_at=?, card_last4=? WHERE id=?",
                (technicien, montant, date, categorie, note, 1 if pending_receipt else 0, filename, updated_at, card_last4, ticket_id),
            )
            conn.commit()
            if old_filename:
                try:
                    os.remove(os.path.join(UPLOAD_DIR, old_filename))
                except OSError:
                    pass
        else:
            conn.execute(
                "UPDATE tickets SET technicien=?, montant=?, date=?, categorie=?, note=?, "
                "pending_receipt=?, updated_at=?, card_last4=? WHERE id=?",
                (technicien, montant, date, categorie, note, 1 if pending_receipt else 0, updated_at, card_last4, ticket_id),
            )
            conn.commit()
    conn.close()
    return jsonify({"ok": True})


if __name__ == "__main__":
    app.run(debug=True, host="0.0.0.0", port=int(os.environ.get("PORT", 5000)))
