# Tickets Terrain — HDPI

Application web pour que les techniciens photographient leurs tickets de frais
de déplacement (péage, essence, repas, parking...) et que l'admin les
consulte, filtre par technicien, et valide ou rejette chaque ticket.

- **Page technicien** (`/`) : accessible à tous, aucun accès à l'admin.
- **Page admin** (`/admin`) : protégée par identifiant + mot de passe.

Les tickets et les photos sont stockés sur le serveur (base SQLite +
dossier `uploads/`), donc tout le monde voit les mêmes données, depuis
n'importe quel téléphone ou ordinateur — pas besoin de compte Claude.

## 1. Avant de mettre en ligne

Ouvrez `config.py` et changez les 3 valeurs :

```python
ADMIN_USERNAME = "admin"              # votre identifiant admin
ADMIN_PASSWORD = "changez-moi"        # un vrai mot de passe
SECRET_KEY = "..."                    # une longue chaîne aléatoire, unique
```

C'est une protection simple (suffisante pour un usage interne HDPI), pas un
coffre-fort bancaire : ne réutilisez pas un mot de passe important ailleurs.

## 2. Héberger gratuitement sur PythonAnywhere (le plus simple, ~10 min)

1. Créez un compte gratuit sur **pythonanywhere.com** ("Create a Beginner
   account").
2. Dans l'onglet **Files**, créez un dossier `ticket_app` et téléversez-y
   tous les fichiers de ce projet (glissez-déposez le zip, ou utilisez
   "Upload a file" pour chaque fichier en gardant la même arborescence :
   `app.py`, `config.py`, `requirements.txt`, `templates/`, `static/`,
   `uploads/`).
3. Onglet **Consoles** → ouvrez une console **Bash**, puis lancez :
   ```
   cd ticket_app
   pip install --user -r requirements.txt
   ```
4. Onglet **Web** → **Add a new web app** → choisissez **Flask** → Python
   3.10 (ou version proposée).
5. Toujours onglet **Web**, dans la section **Code** :
   - **Source code** : `/home/VOTRE_PSEUDO/ticket_app`
   - **WSGI configuration file** : cliquez dessus pour l'éditer, et
     remplacez son contenu par :
     ```python
     import sys
     path = '/home/VOTRE_PSEUDO/ticket_app'
     if path not in sys.path:
         sys.path.insert(0, path)
     from app import app as application
     ```
     (remplacez `VOTRE_PSEUDO` par votre nom d'utilisateur PythonAnywhere,
     visible en haut de la page).
6. Cliquez sur le gros bouton vert **Reload**.
7. Votre application est en ligne sur `https://VOTRE_PSEUDO.pythonanywhere.com` —
   c'est l'adresse à donner à vos techniciens. L'accès admin est sur
   `https://VOTRE_PSEUDO.pythonanywhere.com/admin`.

Le compte gratuit garde l'application en ligne en permanence et les données
(tickets + photos) sont conservées entre les redémarrages.

## 3. Alternative : votre propre serveur / hébergement OVH avec Python

Si vous obtenez un hébergement supportant Python (VPS, serveur dédié) :

```
pip install -r requirements.txt
python app.py
```

Pour un usage réel (pas seulement des tests), lancez plutôt avec un vrai
serveur de production, par exemple avec `gunicorn` :

```
pip install gunicorn
gunicorn -w 2 -b 0.0.0.0:8000 app:app
```

puis faites pointer votre nom de domaine dessus (via Nginx/Apache en
reverse proxy, ou directement selon votre hébergeur).

## 4. Tester en local avant de mettre en ligne

```
pip install -r requirements.txt
python app.py
```

puis ouvrez `http://localhost:5000` dans votre navigateur.

## Structure du projet

```
ticket_app/
  app.py              → serveur (routes technicien + admin)
  config.py           → identifiant/mot de passe admin, clé secrète
  requirements.txt
  templates/
    index.html        → page technicien
    admin_login.html  → connexion admin
    admin.html         → tableau de bord admin
  static/
    style.css         → thème rouge et blanc
    app.js            → logique technicien (photo, envoi, liste)
    admin.js          → logique admin (filtres, validation, rejet)
  uploads/            → photos des tickets (créé/rempli automatiquement)
  tickets.db          → base de données (créée automatiquement au 1er lancement)
```

## Fonctionnement

- Un technicien indique son nom (mémorisé sur son appareil), prend en
  photo son ticket, renseigne montant / date / catégorie / note, et
  l'enregistre. Il retrouve ensuite tous ses tickets avec leur statut
  (en attente, validé, rejeté).
- L'admin se connecte sur `/admin`, voit tous les tickets de tous les
  techniciens, peut filtrer par technicien ou par statut, et valide ou
  rejette chaque ticket (avec un motif optionnel en cas de rejet).
