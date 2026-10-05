(() => {
  const ROOT = "/apps/raffle";
  const formatDuration = (milliseconds) => {
    const seconds = Math.max(0, Math.floor(milliseconds / 1000));
    const days = Math.floor(seconds / 86400);
    const hours = Math.floor((seconds % 86400) / 3600);
    const minutes = Math.floor((seconds % 3600) / 60);
    const remainingSeconds = seconds % 60;
    return `${days > 0 ? days + "d " : ""}${hours}h ${minutes}m ${remainingSeconds}s`;
  };

  document.querySelectorAll("[data-fairdrops-entry]").forEach(async (root) => {
    const rawDrawId = root.dataset.drawId || "latest";
    const specifiedDrawId = rawDrawId.trim() === "" ? "latest" : rawDrawId.trim();
    const selectorWrapper = root.querySelector("[data-draw-selector-wrapper]");
    const selectEl = root.querySelector("[data-draw-select]");
    const titleEl = root.querySelector("[data-draw-title]");
    const countdownEl = root.querySelector("[data-countdown]");
    const statusEl = root.querySelector("[data-draw-status]");
    const reqsEl = root.querySelector("[data-requirements]");
    const messageEl = root.querySelector("[data-customer-message]");
    const button = root.querySelector("[data-entry-button]");
    const login = root.querySelector("[data-login-link]");
    const rulesLink = root.querySelector("[data-official-rules]");

    let availableDraws = [];
    let currentDraw = null;
    let customerId = null;
    let countdownTimer = null;

    const rulesUrl = root.dataset.rulesUrl;
    if (rulesUrl && rulesLink) {
      rulesLink.href = rulesUrl;
      rulesLink.hidden = false;
    }

    const updateCountdown = () => {
      if (!currentDraw) return;
      const now = Date.now();
      const opensAt = new Date(currentDraw.entryOpensAt).getTime();
      const closesAt = new Date(currentDraw.entryClosesAt).getTime();
      if (countdownEl) {
        if (now < opensAt) countdownEl.textContent = `Entries open in ${formatDuration(opensAt - now)}`;
        else if (now < closesAt) countdownEl.textContent = `Entries close in ${formatDuration(closesAt - now)}`;
        else countdownEl.textContent = "Entries are closed";
      }
      const entryWindowOpen = now >= opensAt && now < closesAt;
      const stateAllowsEntry = currentDraw.status === "OPEN" || currentDraw.status === "SCHEDULED";
      if (button) {
        button.disabled = !stateAllowsEntry || !entryWindowOpen;
      }
    };

    const displayDraw = (draw) => {
      currentDraw = draw;
      if (!draw) return;

      if (titleEl && draw.title) titleEl.textContent = draw.title;
      if (statusEl && draw.status) statusEl.textContent = draw.status;

      const rules = draw.eligibility || {};
      const requirementTexts = [];
      if (rules.requireVerifiedEmail) requirementTexts.push("Verified customer email required");
      if (rules.requirePhone) requirementTexts.push("Phone number required");
      if (rules.minAccountAgeDays > 0) requirementTexts.push(`Customer account must be at least ${rules.minAccountAgeDays} days old`);
      if (rules.allowedCountries?.length) requirementTexts.push(`Eligible shipping countries: ${rules.allowedCountries.join(", ")}`);
      
      if (requirementTexts.length && reqsEl) {
        const list = document.createElement("ul");
        list.className = "fairdrops-rules-list";
        requirementTexts.forEach((text) => {
          const item = document.createElement("li");
          item.textContent = text;
          list.append(item);
        });
        reqsEl.innerHTML = "";
        reqsEl.append(list);
      }

      if (customerId) {
        if (button) {
          button.style.display = "inline-block";
          button.disabled = false;
        }
        if (login) login.style.display = "none";
      } else {
        if (button) button.style.display = "none";
        if (login) login.style.display = "inline-block";
      }

      if (messageEl) {
        messageEl.textContent = "";
      }

      updateCountdown();
      if (countdownTimer) clearInterval(countdownTimer);
      countdownTimer = window.setInterval(updateCountdown, 1000);
    };

    try {
      if (specifiedDrawId === "latest") {
        // Fetch all active/scheduled draws for this store
        const response = await fetch(`${ROOT}/draws`, {
          credentials: "same-origin",
          headers: { Accept: "application/json" }
        });
        if (response.ok) {
          const result = await response.json();
          availableDraws = result.draws || [];
          customerId = result.customerId;

          if (availableDraws.length > 1 && selectorWrapper && selectEl) {
            selectEl.innerHTML = "";
            availableDraws.forEach((d) => {
              const opt = document.createElement("option");
              opt.value = d.id;
              opt.textContent = `${d.title} (${d.status})`;
              selectEl.appendChild(opt);
            });
            selectorWrapper.style.display = "block";
            selectEl.addEventListener("change", (e) => {
              const selectedId = e.target.value;
              const found = availableDraws.find((d) => d.id === selectedId);
              if (found) displayDraw(found);
            });
          }

          if (availableDraws.length > 0) {
            displayDraw(availableDraws[0]);
          }
        }
      } else {
        // A specific draw ID was set in block settings
        const response = await fetch(`${ROOT}/draw/${encodeURIComponent(specifiedDrawId)}`, {
          credentials: "same-origin",
          headers: { Accept: "application/json" }
        });
        if (response.ok) {
          const result = await response.json();
          customerId = result.customerId;
          if (result.draw) displayDraw(result.draw);
        }
      }
    } catch {
      // Default HTML content remains cleanly visible
    }

    if (button) {
      button.addEventListener("click", async () => {
        button.disabled = true;
        if (messageEl) {
          messageEl.style.color = "#202223";
          messageEl.textContent = "Submitting your entry…";
        }
        try {
          const targetId = currentDraw?.id || specifiedDrawId;
          const entryResponse = await fetch(`${ROOT}/entry/${encodeURIComponent(targetId)}`, {
            method: "POST",
            credentials: "same-origin",
            headers: { "Content-Type": "application/json" },
            body: "{}",
          });
          const payload = await entryResponse.json();
          if (!entryResponse.ok) {
            if (messageEl) {
              messageEl.style.color = "#d72c0d";
              messageEl.textContent = payload.userMessage || payload.error || "We couldn't submit your entry. Please check requirements.";
            }
            button.disabled = false;
          } else {
            if (messageEl) {
              messageEl.style.color = "#008060";
              messageEl.textContent = "🎉 You're entered! Check your email when the draw completes.";
            }
            button.style.display = "none";
          }
        } catch {
          if (messageEl) {
            messageEl.style.color = "#d72c0d";
            messageEl.textContent = "Error submitting your entry. Please try again.";
          }
          button.disabled = false;
        }
      });
    }

    if (countdownTimer) {
      const observer = new MutationObserver(() => {
        if (!root.isConnected) {
          window.clearInterval(countdownTimer);
          observer.disconnect();
        }
      });
      observer.observe(document.documentElement, { childList: true, subtree: true });
    }
  });
})();
