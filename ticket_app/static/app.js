(function(){
  var $ = function(id){ return document.getElementById(id); };
  var pendingBlob = null;
  var myTickets = [];

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
    resetForm();
    $("captureDialog").showModal();
  });

  function resetForm(){
    $("ticketForm").reset();
    $("dateInput").value = new Date().toISOString().slice(0,10);
    pendingBlob = null;
    $("photoPickerContent").innerHTML = '<span class="icon">📷</span><span>Prendre / choisir une photo du ticket</span>';
    $("submitTicketBtn").disabled = false;
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
    $("photoPickerContent").innerHTML = "<span>Compression de la photo…</span>";
    compressToBlob(file).then(function(blob){
      pendingBlob = blob;
      var url = URL.createObjectURL(blob);
      $("photoPickerContent").innerHTML = '<img src="' + url + '" alt="Aperçu du ticket">';
    }).catch(function(){
      $("photoPickerContent").innerHTML = '<span class="icon">📷</span><span>Échec de lecture — réessayez</span>';
    });
  });

  // ---------- submit ----------
  $("ticketForm").addEventListener("submit", function(e){
    e.preventDefault();
    if(!pendingBlob){
      showToast("Ajoutez une photo du ticket");
      return;
    }
    var montant = parseFloat($("montantInput").value);
    if(!(montant > 0)){
      showToast("Indiquez un montant valide");
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
    fd.append("photo", pendingBlob, "ticket.jpg");

    $("submitTicketBtn").disabled = true;
    fetch("/api/tickets", { method: "POST", body: fd })
      .then(function(res){
        if(!res.ok) return res.json().then(function(d){ throw new Error(d.error || "Erreur"); });
        return res.json();
      })
      .then(function(){
        $("captureDialog").close();
        showToast("Enregistré — " + categorie + " · " + montant.toFixed(2).replace(".", ",") + " €");
        loadMyTickets();
      })
      .catch(function(err){
        showToast(err.message || "Échec de l'enregistrement");
        $("submitTicketBtn").disabled = false;
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

    var img = document.createElement("img");
    img.className = "thumb";
    img.src = t.photo_url || "";
    img.alt = "Ticket " + (t.categorie || "");
    img.addEventListener("click", function(){
      $("lightboxImg").src = t.photo_url || "";
      $("lightbox").showModal();
    });
    card.appendChild(img);

    var main = document.createElement("div");
    main.className = "ticket-main";
    var top = document.createElement("div");
    top.className = "ticket-top";
    top.innerHTML =
      '<span class="ticket-cat">' + escapeHtml(t.categorie || "") + '</span>' +
      '<span class="ticket-date mono">' + frDate(t.date) + '</span>';
    main.appendChild(top);
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

    return card;
  }

  function statTile(label, value, sub, tone){
    var d = document.createElement("div");
    d.className = "stat-tile" + (tone ? " " + tone : "");
    d.innerHTML = '<div class="label">' + label + '</div><div class="value mono">' + value + '</div>' + (sub ? '<div class="sub">' + sub + '</div>' : '');
    return d;
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
    list.innerHTML = "";
    if(!techName){
      list.innerHTML = '<div class="empty-state">Indiquez votre nom pour voir vos tickets.</div>';
      return;
    }
    if(myTickets.length === 0){
      list.innerHTML = '<div class="empty-state">Aucun ticket pour l\'instant — appuyez sur « Nouveau ticket » pour photographier votre premier justificatif.</div>';
      return;
    }
    myTickets.forEach(function(t){ list.appendChild(ticketCard(t)); });
  }

  function loadMyTickets(){
    if(!techName){ myTickets = []; renderTechView(); return; }
    fetch("/api/tickets?technicien=" + encodeURIComponent(techName))
      .then(function(res){ return res.json(); })
      .then(function(data){ myTickets = data; renderTechView(); })
      .catch(function(){ showToast("Impossible de charger vos tickets"); });
  }

  resetForm();
  renderTechView();
  loadMyTickets();
  setInterval(loadMyTickets, 20000);
})();
