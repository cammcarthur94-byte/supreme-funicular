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
    const drawId = rawDrawId.trim() === "" ? "latest" : rawDrawId.trim();
    const titleEl = root.querySelector("[data-draw-title]");
    const countdownEl = root.querySelector("[data-countdown]");
    const statusEl = root.querySelector("[data-draw-status]");
    const reqsEl = root.querySelector("[data-requirements]");
    const messageEl = root.querySelector("[data-customer-message]");
    const button = root.querySelector("[data-entry-button]");
    const login = root.querySelector("[data-login-link]");
    const rulesLink = root.querySelector("[data-official-rules]");
    let draw;
    let timer;

    const rulesUrl = root.dataset.rulesUrl;
    if (rulesUrl && rulesLink) {
      rulesLink.href = rulesUrl;
      rulesLink.hidden = false;
    }

    const updateCountdown = () => {
      if (!draw) return;
      const now = Date.now();
      const opensAt = new Date(draw.entryOpensAt).getTime();
      const closesAt = new Date(draw.entryClosesAt).getTime();
      if (countdownEl) {
        if (now < opensAt) countdownEl.textContent = `Entries open in ${formatDuration(opensAt - now)}`;
        else if (now < closesAt) countdownEl.textContent = `Entries close in ${formatDuration(closesAt - now)}`;
        else countdownEl.textContent = "Entries are closed";
      }
      const entryWindowOpen = now >= opensAt && now < closesAt;
      const stateAllowsEntry = draw.status === "OPEN" || draw.status === "SCHEDULED";
      if (button) {
        button.disabled = !stateAllowsEntry || !entryWindowOpen;
      }
    };

    try {
      const response = await fetch(`${ROOT}/draw/${encodeURIComponent(drawId)}`, {
        credentials: "same-origin",
        headers: { Accept: "application/json" }
      });
      if (response.ok) {
        const result = await response.json();
        draw = result.draw;
        if (draw) {
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
          if (result.customerId) {
            if (button) button.style.display = "inline-block";
            if (login) login.style.display = "none";
          }
          updateCountdown();
          timer = window.setInterval(updateCountdown, 1000);
        }
      }
    } catch {
      // Default HTML content remains safely visible
    }

    if (button) {
      button.addEventListener("click", async () => {
        button.disabled = true;
        if (messageEl) {
          messageEl.style.color = "#202223";
          messageEl.textContent = "Submitting your entry…";
        }
        try {
          const targetId = draw?.id || drawId;
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

    if (timer) {
      const observer = new MutationObserver(() => {
        if (!root.isConnected) {
          window.clearInterval(timer);
          observer.disconnect();
        }
      });
      observer.observe(document.documentElement, { childList: true, subtree: true });
    }
  });
})();
