(function(){
  var $ = function(id){ return document.getElementById(id); };
  var pendingBlob = null;
  var keepExistingPhoto = false;
  var editingTicketId = null;
  var deleteTargetId = null;
  var myTickets = [];
  var capturedLat = null, capturedLng = null, capturedLabel = null;
  var geoToken = 0;
  var userTouchedMontant = false;
  var userTouchedCategorie = false;
  var ocrToken = 0;
  var tesseractLoadPromise = null;

  // ---------- lecture automatique du ticket (OCR gratuit, dans le navigateur) ----------
  function setOcrStatus(text, cls){
    var el = $("ocrStatusText");
    var row = $("ocrStatusText");
    if(!el) return;
    if(!text){ row.style.display = "none"; return; }
    row.style.display = "";
    el.textContent = text;
    row.classList.remove("ok");
    if(cls) row.classList.add(cls);
  }

  function loadTesseract(){
    if(window.Tesseract) return Promise.resolve();
    if(tesseractLoadPromise) return tesseractLoadPromise;
    tesseractLoadPromise = new Promise(function(resolve, reject){
      var s = document.createElement("script");
      s.src = "https://cdnjs.cloudflare.com/ajax/libs/tesseract.js/5.1.1/tesseract.min.js";
      s.onload = function(){ resolve(); };
      s.onerror = function(){ tesseractLoadPromise = null; reject(new Error("load failed")); };
      document.head.appendChild(s);
    });
    return tesseractLoadPromise;
  }

  var CATEGORY_KEYWORDS = [
    ["Péage", ["PEAGE", "PÉAGE", "AUTOROUTE", "APRR", "VINCI", "SANEF", "ASF"]],
    ["Essence", ["ESSENCE", "CARBURANT", "GASOIL", "GAZOLE", "STATION", "TOTAL ENERGIES", "TOTALENERGIES", "SHELL", "ESSO", "BP ", "AVIA"]],
    ["Repas", ["RESTAURANT", "BRASSERIE", "CAFE", "CAFÉ", "PIZZERIA", "BOULANGERIE", "MENU", "COUVERT"]],
    ["Parking", ["PARKING", "STATIONNEMENT", "PARCMETRE", "PARC-METRE"]],
    ["Hébergement", ["HOTEL", "HÔTEL", "NUITEE", "NUITÉE", "CHAMBRE", "IBIS", "B&B", "CAMPANILE"]]
  ];

  function detectCategoryFromText(text){
    var upper = text.toUpperCase();
    for(var i=0; i<CATEGORY_KEYWORDS.length; i++){
      var cat = CATEGORY_KEYWORDS[i][0];
      var keywords = CATEGORY_KEYWORDS[i][1];
      for(var j=0; j<keywords.length; j++){
        if(upper.indexOf(keywords[j]) !== -1) return cat;
      }
    }
    return null;
  }

  function detectAmountFromText(text){
    var lines = text.split(/\r?\n/);
    var numberRe = /(\d{1,4})[.,](\d{2})\b/;
    var totalKeywords = ["TOTAL", "MONTANT", "A PAYER", "À PAYER", "NET A PAYER", "TTC"];
    var best = null;
    // 1) chercher un nombre sur une ligne contenant un mot-clé de total
    for(var i=0; i<lines.length; i++){
      var upperLine = lines[i].toUpperCase();
      var hasKeyword = totalKeywords.some(function(k){ return upperLine.indexOf(k) !== -1; });
      if(hasKeyword){
        var m = lines[i].match(numberRe);
        if(m){
          var val = parseFloat(m[1] + "." + m[2]);
          if(val > 0 && val < 100000) return val;
        }
      }
    }
    // 2) sinon, prendre le plus grand montant trouvé dans tout le texte
    var re = /(\d{1,4})[.,](\d{2})\b/g;
    var match;
    while((match = re.exec(text)) !== null){
      var v = parseFloat(match[1] + "." + match[2]);
      if(v > 0 && v < 100000 && (best === null || v > best)) best = v;
    }
    return best;
  }

  function runOcrAutofill(blob){
    var token = ++ocrToken;
    setOcrStatus("🔎 Lecture automatique du ticket…");
    loadTesseract().then(function(){
      if(token !== ocrToken) return;
      return Tesseract.recognize(blob, "eng");
    }).then(function(result){
      if(!result || token !== ocrToken) return;
      var text = result.data && result.data.text ? result.data.text : "";
      var amount = detectAmountFromText(text);
      var category = detectCategoryFromText(text);
      var applied = [];
      if(amount && !userTouchedMontant){
        $("montantInput").value = amount.toFixed(2);
        applied.push(amount.toFixed(2).replace(".", ",") + " €");
      }
      if(category && !userTouchedCategorie){
        $("categorieInput").value = category;
        applied.push(category);
      }
      if(applied.length){
        setOcrStatus("🔎 Détecté automatiquement : " + applied.join(" · ") + " (vérifiez avant d'enregistrer)", "ok");
      } else {
        setOcrStatus("🔎 Rien détecté automatiquement — complétez les champs manuellement");
      }
    }).catch(function(){
      if(token !== ocrToken) return;
      setOcrStatus("🔎 Lecture automatique indisponible (hors-ligne ou erreur) — complétez manuellement");
    });
  }

  // ---------- localisation (uniquement à la création d'un ticket) ----------
  function setLocationStatus(text, cls){
    var el = $("locationStatusText");
    var row = $("locationRow");
    if(!el || !row) return;
    el.textContent = text;
    row.classList.remove("ok", "off");
    if(cls) row.classList.add(cls);
  }

  function reverseGeocode(lat, lng, token){
    var url = "https://nominatim.openstreetmap.org/reverse?format=jsonv2&lat=" + lat + "&lon=" + lng + "&zoom=14&accept-language=fr";
    fetch(url, { headers: { "Accept": "application/json" } })
      .then(function(res){ return res.ok ? res.json() : null; })
      .then(function(data){
        if(token !== geoToken) return;
        var a = data && data.address;
        var place = a && (a.village || a.town || a.city || a.municipality || a.county);
        var road = a && a.road;
        var label = [road, place].filter(Boolean).join(", ") || place;
        if(label){
          capturedLabel = label;
          setLocationStatus("📍 " + label, "ok");
        } else {
          setLocationStatus("📍 Position enregistrée", "ok");
        }
      })
      .catch(function(){
        if(token !== geoToken) return;
        setLocationStatus("📍 Position enregistrée", "ok");
      });
  }

  function requestLocation(){
    capturedLat = null; capturedLng = null; capturedLabel = null;
    var token = ++geoToken;
    if(!("geolocation" in navigator)){
      setLocationStatus("📍 Localisation non disponible sur cet appareil", "off");
      return;
    }
    setLocationStatus("📍 Détection de la position…", "off");
    navigator.geolocation.getCurrentPosition(
      function(pos){
        if(token !== geoToken) return;
        capturedLat = pos.coords.latitude;
        capturedLng = pos.coords.longitude;
        setLocationStatus("📍 Position enregistrée", "ok");
        reverseGeocode(capturedLat, capturedLng, token);
      },
      function(){
        if(token !== geoToken) return;
        setLocationStatus("📍 Localisation refusée ou indisponible (le ticket sera quand même enregistré)", "off");
      },
      { enableHighAccuracy: false, timeout: 8000, maximumAge: 300000 }
    );
  }

  // ---------- mode hors-ligne : file d'attente locale (IndexedDB) ----------
  var IDB_NAME = "tt_offline_db";
  var IDB_STORE = "queue";
  var isSyncingQueue = false;

  function openOfflineDb(){
    return new Promise(function(resolve, reject){
      if(!("indexedDB" in window)){ reject(new Error("no indexeddb")); return; }
      var req = indexedDB.open(IDB_NAME, 1);
      req.onupgradeneeded = function(){
        req.result.createObjectStore(IDB_STORE, { keyPath: "localId" });
      };
      req.onsuccess = function(){ resolve(req.result); };
      req.onerror = function(){ reject(req.error); };
    });
  }

  function queueOfflineTicket(fields, blob){
    return openOfflineDb().then(function(db){
      return new Promise(function(resolve, reject){
        var tx = db.transaction(IDB_STORE, "readwrite");
        var localId = "local-" + Date.now() + "-" + Math.random().toString(36).slice(2, 8);
        var record = { localId: localId, photoBlob: blob || null, queuedAt: new Date().toISOString() };
        Object.keys(fields).forEach(function(k){ record[k] = fields[k]; });
        tx.objectStore(IDB_STORE).add(record);
        tx.oncomplete = function(){ resolve(localId); };
        tx.onerror = function(){ reject(tx.error); };
      });
    }).catch(function(err){
      showToast("Impossible d'enregistrer hors-ligne sur cet appareil");
      throw err;
    });
  }

  function getQueuedTickets(){
    return openOfflineDb().then(function(db){
      return new Promise(function(resolve, reject){
        var tx = db.transaction(IDB_STORE, "readonly");
        var req = tx.objectStore(IDB_STORE).getAll();
        req.onsuccess = function(){ resolve(req.result || []); };
        req.onerror = function(){ reject(req.error); };
      });
    }).catch(function(){ return []; });
  }

  function removeQueuedTicket(localId){
    return openOfflineDb().then(function(db){
      return new Promise(function(resolve){
        var tx = db.transaction(IDB_STORE, "readwrite");
        tx.objectStore(IDB_STORE).delete(localId);
        tx.oncomplete = function(){ resolve(); };
        tx.onerror = function(){ resolve(); };
      });
    }).catch(function(){});
  }

  function updateOfflineBanner(){
    getQueuedTickets().then(function(items){
      var banner = $("offlineBanner");
      if(!banner) return;
      if(items.length === 0){ banner.style.display = "none"; banner.innerHTML = ""; return; }
      banner.style.display = "flex";
      banner.innerHTML =
        '<span>⏳ ' + items.length + ' ticket(s) en attente d\'envoi (pas de connexion)</span>' +
        '<button type="button" class="btn-sm" id="retrySyncBtn">Réessayer</button>';
      $("retrySyncBtn").addEventListener("click", function(){ flushOfflineQueue(); });
    });
  }

  function flushOfflineQueue(){
    if(isSyncingQueue || !navigator.onLine) return;
    isSyncingQueue = true;
    getQueuedTickets().then(function(items){
      var i = 0;
      function next(){
        if(i >= items.length){
          isSyncingQueue = false;
          updateOfflineBanner();
          loadMyTickets();
          return;
        }
        var item = items[i++];
        var fd = new FormData();
        ["technicien", "montant", "date", "categorie", "note", "pending_receipt", "card_last4", "lat", "lng", "location_label"].forEach(function(k){
          if(item[k] !== undefined && item[k] !== null) fd.append(k, item[k]);
        });
        if(item.photoBlob){ fd.append("photo", item.photoBlob, "ticket.jpg"); }
        fetch("/api/tickets", { method: "POST", body: fd })
          .then(function(res){
            if(!res.ok) throw new Error("sync failed");
            return removeQueuedTicket(item.localId);
          })
          .then(next)
          .catch(function(){ isSyncingQueue = false; updateOfflineBanner(); });
      }
      next();
    }).catch(function(){ isSyncingQueue = false; });
  }

  window.addEventListener("online", function(){ flushOfflineQueue(); });
  var swRegistration = null;
  if("serviceWorker" in navigator){
    navigator.serviceWorker.register("/sw.js")
      .then(function(reg){ swRegistration = reg; refreshNotifRow(); })
      .catch(function(){});
  }

  // ---------- notifications push (rappel du vendredi matin) ----------
  function urlBase64ToUint8Array(base64String){
    var padding = "=".repeat((4 - base64String.length % 4) % 4);
    var base64 = (base64String + padding).replace(/-/g, "+").replace(/_/g, "/");
    var raw = atob(base64);
    var out = new Uint8Array(raw.length);
    for(var i = 0; i < raw.length; i++){ out[i] = raw.charCodeAt(i); }
    return out;
  }

  function pushSupported(){
    return "serviceWorker" in navigator && "PushManager" in window && "Notification" in window;
  }

  function refreshNotifRow(){
    var row = $("notifRow");
    var text = $("notifStatusText");
    var btn = $("notifToggleBtn");
    if(!pushSupported() || !swRegistration){
      row.style.display = "none";
      return;
    }
    row.style.display = "flex";
    if(Notification.permission === "denied"){
      row.className = "notif-row off";
      text.textContent = "🔕 Notifications bloquées (autorisez-les dans les réglages du navigateur)";
      btn.style.display = "none";
      return;
    }
    btn.style.display = "";
    swRegistration.pushManager.getSubscription().then(function(sub){
      if(sub){
        row.className = "notif-row ok";
        text.textContent = "🔔 Rappel du vendredi matin activé";
        btn.textContent = "Désactiver";
      } else {
        row.className = "notif-row off";
        text.textContent = "🔔 Rappel le vendredi matin pour rentrer vos tickets";
        btn.textContent = "Activer";
      }
    });
  }

  function subscribeToPush(){
    Notification.requestPermission().then(function(perm){
      if(perm !== "granted"){ refreshNotifRow(); return; }
      fetch("/api/push/vapid-public-key")
        .then(function(res){ return res.json(); })
        .then(function(data){
          if(!data.publicKey){
            showToast("Notifications indisponibles pour le moment");
            return;
          }
          return swRegistration.pushManager.subscribe({
            userVisibleOnly: true,
            applicationServerKey: urlBase64ToUint8Array(data.publicKey),
          }).then(function(sub){
            return fetch("/api/push/subscribe", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ technicien: techName, subscription: sub.toJSON() }),
            });
          });
        })
        .then(function(){ showToast("Rappels activés"); refreshNotifRow(); })
        .catch(function(){ showToast("Impossible d'activer les rappels"); refreshNotifRow(); });
    });
  }

  function unsubscribeFromPush(){
    swRegistration.pushManager.getSubscription().then(function(sub){
      if(!sub){ refreshNotifRow(); return; }
      var endpoint = sub.endpoint;
      sub.unsubscribe().then(function(){
        return fetch("/api/push/unsubscribe", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ endpoint: endpoint }),
        });
      }).then(function(){ showToast("Rappels désactivés"); refreshNotifRow(); });
    });
  }

  $("notifToggleBtn").addEventListener("click", function(){
    if(!swRegistration) return;
    swRegistration.pushManager.getSubscription().then(function(sub){
      if(sub){ unsubscribeFromPush(); } else { subscribeToPush(); }
    });
  });

  // ---------- thème clair / sombre ----------
  function updateThemeIcon(){
    $("themeToggleBtn").textContent = ttCurrentTheme() === "dark" ? "☀️" : "🌙";
  }
  $("themeToggleBtn").addEventListener("click", ttToggleTheme);
  document.addEventListener("tt-theme-changed", updateThemeIcon);
  updateThemeIcon();

  function readLocal(key, fallback){
    try { return localStorage.getItem(key) || fallback; } catch(e){ return fallback; }
  }
  function writeLocal(key, val){
    try { localStorage.setItem(key, val); } catch(e){}
  }

  var techName = readLocal("tt_tech_name", "");
  $("techName").value = techName;

  $("techName").addEventListener("change", function(){
    techName = $("techName").value.trim();
    writeLocal("tt_tech_name", techName);
    loadMyTickets();
  });

  // ---------- suggestions de noms déjà utilisés ----------
  fetch("/api/technicians")
    .then(function(res){ return res.json(); })
    .then(function(names){
      var list = $("techNameList");
      list.innerHTML = "";
      (names || []).forEach(function(n){
        var opt = document.createElement("option");
        opt.value = n;
        list.appendChild(opt);
      });
    })
    .catch(function(){});

  // ---------- toast ----------
  var toastTimer = null;
  function showToast(msg){
    var t = $("toast");
    t.textContent = msg;
    t.classList.add("show");
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function(){ t.classList.remove("show"); }, 3200);
  }

  // ---------- dialogs ----------
  document.querySelectorAll("[data-close]").forEach(function(b){
    b.addEventListener("click", function(){ $(b.dataset.close).close(); });
  });
  $("lightbox").addEventListener("click", function(){ $("lightbox").close(); });

  $("newTicketBtn").addEventListener("click", function(){
    if(!techName){
      $("techName").focus();
      showToast("Indiquez votre nom d'abord");
      return;
    }
    openCreateForm();
  });

  function defaultPhotoLabel(){
    return '<span class="icon">📷</span><span>Prendre / choisir une photo du ticket</span>';
  }

  function openCreateForm(){
    editingTicketId = null;
    $("ticketForm").reset();
    $("dateInput").value = new Date().toISOString().slice(0,10);
    pendingBlob = null;
    keepExistingPhoto = false;
    $("photoPickerContent").innerHTML = defaultPhotoLabel();
    $("submitTicketBtn").disabled = false;
    $("submitTicketBtn").textContent = "Enregistrer";
    document.querySelector("#captureDialog .dialog-head h2").textContent = "Nouveau ticket";
    $("locationRow").style.display = "";
    requestLocation();
    userTouchedMontant = false;
    userTouchedCategorie = false;
    ocrToken++;
    setOcrStatus("");
    $("captureDialog").showModal();
  }

  function openEditForm(t){
    editingTicketId = t.id;
    $("ticketForm").reset();
    pendingBlob = null;
    keepExistingPhoto = !!t.photo_url;
    $("montantInput").value = t.montant;
    $("cardLast4Input").value = t.card_last4 || "";
    $("dateInput").value = t.date;
    $("categorieInput").value = t.categorie;
    $("noteInput").value = t.note || "";
    $("pendingReceiptInput").checked = !!t.pending_receipt;
    $("photoPickerContent").innerHTML = t.photo_url
      ? '<img src="' + t.photo_url + '" alt="Photo actuelle">'
      : defaultPhotoLabel();
    $("submitTicketBtn").disabled = false;
    $("submitTicketBtn").textContent = "Enregistrer les modifications";
    document.querySelector("#captureDialog .dialog-head h2").textContent = "Modifier le ticket";
    geoToken++; // annule une détection de position en cours
    capturedLat = null; capturedLng = null; capturedLabel = null;
    $("locationRow").style.display = "none";
    ocrToken++; // pas de relecture automatique en modification
    setOcrStatus("");
    $("captureDialog").showModal();
  }

  // ---------- photo compression ----------
  function compressToBlob(file){
    return new Promise(function(resolve, reject){
      var reader = new FileReader();
      reader.onerror = reject;
      reader.onload = function(){
        var img = new Image();
        img.onerror = reject;
        img.onload = function(){
          var dims = [1600, 1280, 1000, 800];
          var qualities = [0.8, 0.65, 0.5, 0.4];
          var targetBytes = 380000;
          var di = 0, qi = 0;

          function tryNext(lastBlob){
            if(di >= dims.length){ resolve(lastBlob); return; }
            var maxDim = dims[di];
            var scale = Math.min(1, maxDim / Math.max(img.width, img.height));
            var w = Math.max(1, Math.round(img.width * scale));
            var h = Math.max(1, Math.round(img.height * scale));
            var canvas = document.createElement("canvas");
            canvas.width = w; canvas.height = h;
            var ctx = canvas.getContext("2d");
            ctx.drawImage(img, 0, 0, w, h);

            canvas.toBlob(function(blob){
              if(!blob){ reject(new Error("toBlob failed")); return; }
              if(blob.size <= targetBytes || (di === dims.length - 1 && qi === qualities.length - 1)){
                resolve(blob);
                return;
              }
              qi++;
              if(qi >= qualities.length){ qi = 0; di++; }
              tryNext(blob);
            }, "image/jpeg", qualities[qi]);
          }
          tryNext(null);
        };
        img.src = reader.result;
      };
      reader.readAsDataURL(file);
    });
  }

  $("photoInput").addEventListener("change", function(){
    var file = $("photoInput").files[0];
    if(!file) return;
    keepExistingPhoto = false;
    $("photoPickerContent").innerHTML = "<span>Compression de la photo…</span>";
    compressToBlob(file).then(function(blob){
      pendingBlob = blob;
      var url = URL.createObjectURL(blob);
      $("photoPickerContent").innerHTML = '<img src="' + url + '" alt="Aperçu du ticket">';
      if(!editingTicketId){
        runOcrAutofill(blob);
      }
    }).catch(function(){
      $("photoPickerContent").innerHTML = '<span class="icon">📷</span><span>Échec de lecture — réessayez</span>';
    });
  });

  $("montantInput").addEventListener("input", function(){ userTouchedMontant = true; });
  $("categorieInput").addEventListener("change", function(){ userTouchedCategorie = true; });
  $("cardLast4Input").addEventListener("input", function(){
    this.value = this.value.replace(/\D/g, "").slice(0, 4);
  });

  // ---------- submit (création ou modification) ----------
  $("ticketForm").addEventListener("submit", function(e){
    e.preventDefault();
    var pendingReceipt = $("pendingReceiptInput").checked;
    var hasPhoto = !!pendingBlob || keepExistingPhoto;
    if(!hasPhoto && !pendingReceipt){
      showToast("Ajoutez une photo, ou cochez « justificatif en attente »");
      return;
    }
    var montant = parseFloat($("montantInput").value);
    if(!(montant > 0)){
      showToast("Indiquez un montant valide");
      return;
    }
    var cardLast4 = $("cardLast4Input").value.trim();
    if(!/^\d{4}$/.test(cardLast4)){
      showToast("Indiquez les 4 derniers chiffres de la carte bancaire utilisée");
      $("cardLast4Input").focus();
      return;
    }
    var categorie = $("categorieInput").value;
    var date = $("dateInput").value;
    var note = $("noteInput").value.trim();

    var fd = new FormData();
    fd.append("technicien", techName);
    fd.append("montant", montant);
    fd.append("date", date);
    fd.append("categorie", categorie);
    fd.append("note", note);
    fd.append("pending_receipt", pendingReceipt ? "1" : "0");
    fd.append("card_last4", cardLast4);
    if(pendingBlob){
      fd.append("photo", pendingBlob, "ticket.jpg");
    }
    if(!editingTicketId && capturedLat != null && capturedLng != null){
      fd.append("lat", capturedLat);
      fd.append("lng", capturedLng);
      if(capturedLabel) fd.append("location_label", capturedLabel);
    }

    var isEdit = !!editingTicketId;
    var url = isEdit ? "/api/tickets/" + editingTicketId : "/api/tickets";

    // Hors-ligne (nouveau ticket uniquement) : on ne tente même pas le réseau,
    // on met directement en file d'attente locale.
    if(!isEdit && !navigator.onLine){
      queueOfflineTicket({
        technicien: techName, montant: montant, date: date, categorie: categorie, note: note,
        pending_receipt: pendingReceipt ? "1" : "0", card_last4: cardLast4,
        lat: capturedLat, lng: capturedLng, location_label: capturedLabel
      }, pendingBlob).then(function(){
        $("captureDialog").close();
        showToast("Pas de connexion — ticket enregistré et prêt à être envoyé dès le retour du réseau");
        renderTechView();
        updateOfflineBanner();
      });
      return;
    }

    $("submitTicketBtn").disabled = true;
    fetch(url, { method: isEdit ? "PUT" : "POST", body: fd })
      .then(function(res){
        if(!res.ok) return res.json().then(function(d){ throw new Error(d.error || "Erreur"); });
        return res.json();
      })
      .then(function(){
        $("captureDialog").close();
        showToast(isEdit ? "Ticket modifié" : "Enregistré — " + categorie + " · " + montant.toFixed(2).replace(".", ",") + " €");
        loadMyTickets();
      })
      .catch(function(err){
        if(!isEdit && err instanceof TypeError){
          // Échec réseau (pas juste une erreur applicative) : on bascule en file d'attente locale.
          queueOfflineTicket({
            technicien: techName, montant: montant, date: date, categorie: categorie, note: note,
            pending_receipt: pendingReceipt ? "1" : "0", card_last4: cardLast4,
            lat: capturedLat, lng: capturedLng, location_label: capturedLabel
          }, pendingBlob).then(function(){
            $("captureDialog").close();
            showToast("Pas de connexion — ticket enregistré et prêt à être envoyé dès le retour du réseau");
            renderTechView();
            updateOfflineBanner();
          });
          return;
        }
        showToast(err.message || "Échec de l'enregistrement");
        $("submitTicketBtn").disabled = false;
      });
  });

  // ---------- suppression ----------
  $("deleteConfirmDialog").addEventListener("click", function(e){ if(e.target === this) this.close(); });
  $("confirmDeleteBtn").addEventListener("click", function(){
    if(!deleteTargetId) return;
    fetch("/api/tickets/" + deleteTargetId + "?technicien=" + encodeURIComponent(techName), { method: "DELETE" })
      .then(function(res){
        if(!res.ok) return res.json().then(function(d){ throw new Error(d.error || "Erreur"); });
        return res.json();
      })
      .then(function(){
        $("deleteConfirmDialog").close();
        showToast("Ticket supprimé");
        loadMyTickets();
      })
      .catch(function(err){
        showToast(err.message || "Échec de la suppression");
      });
  });

  // ---------- formatting ----------
  function eur(n){ return (Math.round(n*100)/100).toFixed(2).replace(".", ",") + " €"; }
  function frDate(iso){
    if(!iso) return "";
    var p = iso.split("-");
    if(p.length !== 3) return iso;
    return p[2] + "/" + p[1] + "/" + p[0];
  }
  var STATUS_LABEL = { en_attente:"En attente", valide:"Validé", rejete:"Rejeté" };

  function escapeHtml(s){
    return String(s).replace(/[&<>"']/g, function(c){
      return {"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c];
    });
  }

  function ticketCard(t){
    var card = document.createElement("div");
    card.className = "ticket-card";

    if(t.photo_url){
      var img = document.createElement("img");
      img.className = "thumb";
      img.src = t.photo_url;
      img.alt = "Ticket " + (t.categorie || "");
      img.addEventListener("click", function(){
        $("lightboxImg").src = t.photo_url;
        $("lightbox").showModal();
      });
      card.appendChild(img);
    } else {
      var ph = document.createElement("div");
      ph.className = "thumb-placeholder";
      ph.textContent = "🕒";
      card.appendChild(ph);
    }

    var main = document.createElement("div");
    main.className = "ticket-main";
    var top = document.createElement("div");
    top.className = "ticket-top";
    top.innerHTML =
      '<span class="ticket-cat">' + escapeHtml(t.categorie || "") + '</span>' +
      '<span class="ticket-date mono">' + frDate(t.date) + '</span>';
    if(t.pending_receipt && !t.photo_url){
      top.innerHTML += '<span class="pending-badge">' + escapeHtml(t.categorie || "Justificatif") + ' en attente</span>';
    }
    if(t.card_last4){
      top.innerHTML += '<span class="card-badge">💳 •••• ' + escapeHtml(t.card_last4) + '</span>';
    }
    main.appendChild(top);
    if(t.lat != null && t.lng != null){
      var locA = document.createElement("a");
      locA.className = "location-badge";
      locA.href = "https://www.openstreetmap.org/?mlat=" + t.lat + "&mlon=" + t.lng + "#map=16/" + t.lat + "/" + t.lng;
      locA.target = "_blank";
      locA.rel = "noopener";
      locA.textContent = "📍 " + (t.location_label || "Voir sur la carte");
      main.appendChild(locA);
    }
    if(t.note){
      var note = document.createElement("div");
      note.className = "ticket-note";
      note.textContent = t.note;
      main.appendChild(note);
    }
    if(t.status !== "en_attente" && t.admin_note){
      var an = document.createElement("div");
      an.className = "ticket-note";
      an.textContent = "Admin : " + t.admin_note;
      main.appendChild(an);
    }
    card.appendChild(main);

    var side = document.createElement("div");
    side.className = "ticket-side";
    var amt = document.createElement("div");
    amt.className = "ticket-amount mono";
    amt.textContent = eur(t.montant || 0);
    side.appendChild(amt);
    var pill = document.createElement("span");
    pill.className = "pill " + t.status;
    pill.textContent = STATUS_LABEL[t.status] || t.status;
    side.appendChild(pill);
    card.appendChild(side);

    if(t.status === "en_attente"){
      var actions = document.createElement("div");
      actions.className = "tech-actions";
      var editBtn = document.createElement("button");
      editBtn.className = "btn-sm"; editBtn.type = "button"; editBtn.textContent = "Modifier";
      editBtn.addEventListener("click", function(){ openEditForm(t); });
      actions.appendChild(editBtn);
      var delBtn = document.createElement("button");
      delBtn.className = "btn-sm bad-btn"; delBtn.type = "button"; delBtn.textContent = "Supprimer";
      delBtn.addEventListener("click", function(){
        deleteTargetId = t.id;
        $("deleteConfirmDialog").showModal();
      });
      actions.appendChild(delBtn);
      card.appendChild(actions);
    }

    return card;
  }

  function statTile(label, value, sub, tone){
    var d = document.createElement("div");
    d.className = "stat-tile" + (tone ? " " + tone : "");
    d.innerHTML = '<div class="label">' + label + '</div><div class="value mono">' + value + '</div>' + (sub ? '<div class="sub">' + sub + '</div>' : '');
    return d;
  }

  function offlineTicketCard(item){
    var card = document.createElement("div");
    card.className = "ticket-card";
    if(item.photoBlob){
      var img = document.createElement("img");
      img.className = "thumb";
      img.src = URL.createObjectURL(item.photoBlob);
      img.alt = "Ticket " + (item.categorie || "");
      card.appendChild(img);
    } else {
      var ph = document.createElement("div");
      ph.className = "thumb-placeholder";
      ph.textContent = "🕒";
      card.appendChild(ph);
    }
    var main = document.createElement("div");
    main.className = "ticket-main";
    main.innerHTML =
      '<div class="ticket-top"><span class="ticket-cat">' + escapeHtml(item.categorie || "") + '</span>' +
      '<span class="ticket-date mono">' + frDate(item.date) + '</span>' +
      (item.card_last4 ? '<span class="card-badge">💳 •••• ' + escapeHtml(item.card_last4) + '</span>' : '') +
      '<span class="sync-badge">⏳ En attente d\'envoi</span></div>';
    card.appendChild(main);
    var side = document.createElement("div");
    side.className = "ticket-side";
    var amt = document.createElement("div");
    amt.className = "ticket-amount mono";
    amt.textContent = eur(parseFloat(item.montant) || 0);
    side.appendChild(amt);
    card.appendChild(side);
    return card;
  }

  function renderTechView(){
    var enAttente = myTickets.filter(function(t){ return t.status === "en_attente"; });
    var valide = myTickets.filter(function(t){ return t.status === "valide"; });
    var sumEnAttente = enAttente.reduce(function(s,t){ return s + (t.montant||0); }, 0);
    var sumValide = valide.reduce(function(s,t){ return s + (t.montant||0); }, 0);

    $("techSummary").innerHTML = "";
    $("techSummary").appendChild(statTile("Tickets soumis", String(myTickets.length), "", "accent"));
    $("techSummary").appendChild(statTile("En attente", eur(sumEnAttente), enAttente.length + " ticket(s)", "warn"));
    $("techSummary").appendChild(statTile("Validé", eur(sumValide), valide.length + " ticket(s)", "ok"));

    var list = $("techTicketList");
    if(!techName){
      list.innerHTML = '<div class="empty-state">Indiquez votre nom pour voir vos tickets.</div>';
      return;
    }
    getQueuedTickets().then(function(queued){
      var mine = queued.filter(function(q){ return (q.technicien || "").trim().toLowerCase() === techName.toLowerCase(); });
      list.innerHTML = "";
      if(myTickets.length === 0 && mine.length === 0){
        list.innerHTML = '<div class="empty-state">Aucun ticket pour l\'instant — appuyez sur « Nouveau ticket » pour photographier votre premier justificatif.</div>';
        return;
      }
      mine.forEach(function(q){ list.appendChild(offlineTicketCard(q)); });
      myTickets.forEach(function(t){ list.appendChild(ticketCard(t)); });
    });
  }

  function loadMyTickets(){
    if(!techName){ myTickets = []; renderTechView(); return; }
    fetch("/api/tickets?technicien=" + encodeURIComponent(techName))
      .then(function(res){ return res.json(); })
      .then(function(data){ myTickets = data; renderTechView(); })
      .catch(function(){ showToast("Impossible de charger vos tickets"); });
  }

  renderTechView();
  loadMyTickets();
  updateOfflineBanner();
  flushOfflineQueue();
  setInterval(loadMyTickets, 20000);
  setInterval(flushOfflineQueue, 30000);
})();
