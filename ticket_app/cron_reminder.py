"""Script exécuté par la tâche planifiée (Render Cron Job) : appelle
l'application déjà en ligne pour déclencher, si besoin, le rappel push du
vendredi matin. Ne dépend d'aucune bibliothèque externe (urllib suffit),
et ne touche jamais directement la base de données : toute la logique
(heure de Paris, anti-doublon, envoi) vit dans app.py, côté service web.

Ce script est volontairement appelé plus souvent qu'une fois par semaine
(voir la planification du cron) : c'est app.py qui décide, à chaque appel,
si c'est vraiment le bon moment d'envoyer (vendredi, 8h30 heure de Paris,
pas déjà envoyé aujourd'hui). Cela évite tout souci lié au changement
d'heure été/hiver, puisqu'on se base sur l'heure réelle de Paris et non
sur un horaire UTC figé.
"""
import json
import os
import sys
import urllib.error
import urllib.request

APP_URL = os.environ.get("APP_URL", "https://hdpi-tickets-terrain.onrender.com")
CRON_SECRET = os.environ.get("CRON_SECRET", "")


def main():
    if not CRON_SECRET:
        print("CRON_SECRET manquant, arrêt.")
        sys.exit(1)

    url = APP_URL.rstrip("/") + "/api/push/cron-trigger"
    req = urllib.request.Request(url, method="POST", headers={"X-Cron-Secret": CRON_SECRET})
    try:
        with urllib.request.urlopen(req, timeout=25) as resp:
            body = resp.read().decode("utf-8", errors="replace")
            print(resp.status, body)
    except urllib.error.HTTPError as exc:
        print("Erreur HTTP", exc.code, exc.read().decode("utf-8", errors="replace"))
        sys.exit(1)
    except Exception as exc:
        print("Erreur lors de l'appel au rappel push:", exc)
        sys.exit(1)


if __name__ == "__main__":
    main()
