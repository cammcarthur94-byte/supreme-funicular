(() => {
  const ROOT = "/apps/raffle";
  const formatDuration = (milliseconds) => {
    const seconds = Math.max(0, Math.floor(milliseconds / 1000));
    const days = Math.floor(seconds / 86400);
    const hours = Math.floor((seconds % 86400) / 3600);
    const minutes = Math.floor((seconds % 3600) / 60);
    const remainingSeconds = seconds % 60;
    return `${days}d ${hours}h ${minutes}m ${remainingSeconds}s`;
  };

  document.querySelectorAll("[data-fairdrops-entry]").forEach(async (root) => {
    const drawId = root.dataset.drawId;
    const status = root.querySelector("[data-entry-status]");
    const content = root.querySelector("[data-entry-content]");
    const message = root.querySelector("[data-customer-message]");
    const button = root.querySelector("[data-entry-button]");
    const login = root.querySelector("[data-login-link]");
    let draw;
    let timer;

    const setStatus = (text) => { status.textContent = text; };
    const updateCountdown = () => {
      const now = Date.now();
      const opensAt = new Date(draw.entryOpensAt).getTime();
      const closesAt = new Date(draw.entryClosesAt).getTime();
      const countdown = root.querySelector("[data-countdown]");
      if (now < opensAt) countdown.textContent = `Entries open in ${formatDuration(opensAt - now)}`;
      else if (now < closesAt) countdown.textContent = `Entries close in ${formatDuration(closesAt - now)}`;
      else countdown.textContent = "Entries are closed";
      const entryWindowOpen = now >= opensAt && now < closesAt;
      const stateAllowsEntry = draw.status === "OPEN" || draw.status === "SCHEDULED";
      button.disabled = !draw.customerId || !stateAllowsEntry || !entryWindowOpen;
    };

    try {
      const response = await fetch(`${ROOT}/draw/${encodeURIComponent(drawId)}`, { credentials: "same-origin" });
      if (!response.ok) throw new Error("Draw unavailable");
      const result = await response.json();
      draw = result.draw;
      draw.customerId = result.customerId;
      content.hidden = false;
      root.querySelector("[data-draw-title]").textContent = draw.title;
      const requirements = root.querySelector("[data-requirements]");
      const rules = draw.eligibility || {};
      const requirementTexts = [];
      if (rules.requireVerifiedEmail) requirementTexts.push("Verified email required");
      if (rules.requirePhone) requirementTexts.push("Phone number required");
      if (rules.minAccountAgeDays > 0) requirementTexts.push(`Customer account must be at least ${rules.minAccountAgeDays} days old`);
      if (rules.allowedCountries?.length) requirementTexts.push(`Shipping country: ${rules.allowedCountries.join(", ")}`);
      if (requirementTexts.length) {
        const list = document.createElement("ul");
        requirementTexts.forEach((text) => { const item = document.createElement("li"); item.textContent = text; list.append(item); });
        requirements.append(list);
      }
      if (draw.publicRulesText) {
        const rulesText = document.createElement("p");
        rulesText.textContent = draw.publicRulesText;
        requirements.append(rulesText);
      }
      const rulesUrl = root.dataset.rulesUrl;
      if (rulesUrl) {
        const officialRules = root.querySelector("[data-official-rules]");
        officialRules.href = rulesUrl;
        officialRules.hidden = false;
      }
      if (!draw.customerId && draw.requireAccount) login.hidden = false;
      if (!draw.customerId && !draw.requireAccount) message.textContent = "Log in to your customer account to verify eligibility and enter.";
      updateCountdown();
      timer = window.setInterval(updateCountdown, 1000);
      button.addEventListener("click", async () => {
        button.disabled = true;
        message.textContent = "Submitting your entry…";
        try {
          const entryResponse = await fetch(`${ROOT}/entry/${encodeURIComponent(drawId)}`, {
            method: "POST",
            credentials: "same-origin",
            headers: { "Content-Type": "application/json" },
            body: "{}",
          });
          const payload = await entryResponse.json();
          if (!entryResponse.ok) {
            if (entryResponse.status === 401 && draw.requireAccount) login.hidden = false;
            message.textContent = payload.error || "We couldn't submit your entry. Please try again.";
          } else {
            message.textContent = payload.message;
          }
        } catch {
          message.textContent = "We couldn't submit your entry. Please try again.";
        }
        updateCountdown();
      });
      status.hidden = true;
    } catch {
      setStatus("This draw is currently unavailable.");
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
