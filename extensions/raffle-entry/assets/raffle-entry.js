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

  async function getDeviceFingerprintHash() {
    try {
      const components = [
        navigator.userAgent || "",
        navigator.language || "",
        screen.width || 0,
        screen.height || 0,
        screen.colorDepth || 0,
        new Date().getTimezoneOffset(),
        navigator.hardwareConcurrency || 1,
        navigator.platform || ""
      ].join("###");
      const buffer = new TextEncoder().encode(components);
      const hashBuffer = await crypto.subtle.digest("SHA-256", buffer);
      const hashArray = Array.from(new Uint8Array(hashBuffer));
      return hashArray.map((b) => b.toString(16).padStart(2, "0")).join("");
    } catch {
      return "fp_client_" + Math.random().toString(36).substring(2);
    }
  }

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
    const honeypotEl = root.querySelector("[data-fairdrops-honeypot]");
    const turnstileContainer = root.querySelector("[data-turnstile-container]");
    const variantsBox = root.querySelector("[data-variants-box]");
    const variantsGrid = root.querySelector("[data-variants-grid]");
    const variantSelectedTitleEl = root.querySelector("[data-variant-selected-title]");

    let availableDraws = [];
    let currentDraw = null;
    let customerId = null;
    let countdownTimer = null;
    let formToken = null;
    let turnstileSiteKey = "1x00000000000000000000AA";
    let turnstileToken = null;
    let turnstileWidgetId = null;
    let selectedVariantGid = null;

    const rulesUrl = root.dataset.rulesUrl;
    if (rulesUrl && rulesLink) {
      rulesLink.href = rulesUrl;
      rulesLink.hidden = false;
    }

    const initTurnstile = (siteKey) => {
      if (!turnstileContainer || !siteKey) return;
      let attempts = 0;
      const render = () => {
        if (window.turnstile && typeof window.turnstile.render === "function") {
          try {
            if (turnstileWidgetId !== null) {
              window.turnstile.reset(turnstileWidgetId);
              turnstileToken = null;
            } else {
              turnstileWidgetId = window.turnstile.render(turnstileContainer, {
                sitekey: siteKey,
                theme: "light",
                callback: (tok) => {
                  turnstileToken = tok;
                },
                "error-callback": () => {
                  turnstileToken = null;
                },
                "expired-callback": () => {
                  turnstileToken = null;
                },
              });
            }
          } catch (e) {
            console.warn("Turnstile init notice:", e);
          }
        } else if (attempts < 20) {
          attempts++;
          setTimeout(render, 250);
        }
      };
      render();
    };

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

    const showMessage = (type, text) => {
      if (!messageEl) return;
      messageEl.className = `fairdrops-message fairdrops-message-${type}`;
      messageEl.textContent = text;
      messageEl.style.display = "flex";
    };

    const clearMessage = () => {
      if (!messageEl) return;
      messageEl.style.display = "none";
      messageEl.textContent = "";
    };

    const displayDraw = async (draw) => {
      currentDraw = draw;
      if (!draw) return;

      formToken = draw.formToken || formToken;

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
        initTurnstile(turnstileSiteKey);
      } else {
        if (button) button.style.display = "none";
        if (login) login.style.display = "inline-block";
      }

      clearMessage();

      // Variant / Size Selector setup
      const variants = draw.variants || [];
      if (variants.length > 0 && variantsBox && variantsGrid) {
        variantsGrid.innerHTML = "";
        selectedVariantGid = variants[0].variantGid;
        if (variantSelectedTitleEl) {
          variantSelectedTitleEl.textContent = variants[0].title;
        }

        variants.forEach((v, index) => {
          const chip = document.createElement("button");
          chip.type = "button";
          chip.className = `fairdrops-variant-chip ${index === 0 ? "fairdrops-variant-chip-selected" : ""}`;
          chip.dataset.variantGid = v.variantGid;
          chip.textContent = v.title;
          chip.addEventListener("click", () => {
            selectedVariantGid = v.variantGid;
            variantsGrid.querySelectorAll(".fairdrops-variant-chip").forEach((el) => {
              el.classList.remove("fairdrops-variant-chip-selected");
            });
            chip.classList.add("fairdrops-variant-chip-selected");
            if (variantSelectedTitleEl) {
              variantSelectedTitleEl.textContent = v.title;
            }
          });
          variantsGrid.appendChild(chip);
        });
        variantsBox.style.display = "block";
      } else if (variantsBox) {
        variantsBox.style.display = "none";
        selectedVariantGid = null;
      }

      updateCountdown();
      if (countdownTimer) clearInterval(countdownTimer);
      countdownTimer = window.setInterval(updateCountdown, 1000);
    };

    try {
      if (specifiedDrawId === "latest") {
        const response = await fetch(`${ROOT}/draws`, {
          credentials: "same-origin",
          headers: { Accept: "application/json" }
        });
        if (response.ok) {
          const result = await response.json();
          availableDraws = result.draws || [];
          customerId = result.customerId;
          if (result.turnstileSiteKey) turnstileSiteKey = result.turnstileSiteKey;

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
            await displayDraw(availableDraws[0]);
          }
        }
      } else {
        const response = await fetch(`${ROOT}/draw/${encodeURIComponent(specifiedDrawId)}`, {
          credentials: "same-origin",
          headers: { Accept: "application/json" }
        });
        if (response.ok) {
          const result = await response.json();
          customerId = result.customerId;
          if (result.turnstileSiteKey) turnstileSiteKey = result.turnstileSiteKey;
          if (result.formToken) formToken = result.formToken;
          if (result.draw) await displayDraw(result.draw);
        }
      }
    } catch {
      // Default HTML content remains cleanly visible
    }

    const btnSpinner = root.querySelector("[data-btn-spinner]");
    const btnText = root.querySelector("[data-btn-text]");

    const setButtonLoading = (loading) => {
      if (!button) return;
      button.disabled = loading;
      if (btnSpinner) btnSpinner.style.display = loading ? "inline-block" : "none";
      if (btnText) btnText.textContent = loading ? "Submitting Entry..." : "Enter This Draw";
    };

    if (button) {
      button.addEventListener("click", async () => {
        setButtonLoading(true);
        showMessage("info", "Verifying security & submitting your entry…");

        try {
          const targetId = currentDraw?.id || specifiedDrawId;
          const customerMeta = root.querySelector("[data-customer-meta]");
          const customerData = customerMeta ? {
            email: customerMeta.dataset.email || undefined,
            verifiedEmail: customerMeta.dataset.verified !== "false",
            countryCode: customerMeta.dataset.country || undefined,
            createdAt: customerMeta.dataset.created || undefined,
            phone: customerMeta.dataset.phone || undefined,
          } : {};

          // If no form token yet, obtain one from server
          if (!formToken && targetId) {
            try {
              const tokenRes = await fetch(`${ROOT}/form-token/${encodeURIComponent(targetId)}`, {
                credentials: "same-origin",
                headers: { Accept: "application/json" },
              });
              if (tokenRes.ok) {
                const tokenData = await tokenRes.json();
                formToken = tokenData.formToken;
              }
            } catch {
              // will be verified server-side
            }
          }

          // Calculate client fingerprint hash
          const deviceFingerprintHash = await getDeviceFingerprintHash();

          // Get honeypot value if any
          const honeypotVal = honeypotEl ? (honeypotEl.value || "") : "";

          const entryResponse = await fetch(`${ROOT}/entry/${encodeURIComponent(targetId)}`, {
            method: "POST",
            credentials: "same-origin",
            headers: {
              "Content-Type": "application/json",
              "Accept": "application/json",
            },
            body: JSON.stringify({
              customerData,
              formToken,
              turnstileToken,
              deviceFingerprintHash,
              website_hp_check: honeypotVal,
              selectedVariantGid,
            }),
          });

          let payload = {};
          let responseText = "";
          try {
            responseText = await entryResponse.text();
            payload = JSON.parse(responseText);
          } catch {
            console.error("Non-JSON entry response:", entryResponse.status, responseText);
            payload = {
              error: "Unable to submit your entry right now. The server is temporarily reconnecting. Please refresh and try again."
            };
          }

          if (!entryResponse.ok) {
            let userMsg = payload.userMessage || payload.error;
            if (entryResponse.status === 409 && (!userMsg || userMsg.includes("closed"))) {
              userMsg = "Entries for this draw are currently closed.";
            } else if (entryResponse.status === 409) {
              userMsg = "You've already entered this draw! We'll notify you if you are selected.";
            } else if (entryResponse.status === 429) {
              userMsg = "Too many entry attempts in a short period. Please slow down and try again in a few moments.";
            } else if (!userMsg) {
              userMsg = "We couldn't submit your entry. Please check eligibility requirements and try again.";
            }
            showMessage("error", userMsg);

            if (window.turnstile && turnstileWidgetId !== null) {
              window.turnstile.reset(turnstileWidgetId);
              turnstileToken = null;
            }
            setButtonLoading(false);
          } else {
            const selectedVariantObj = (currentDraw?.variants || []).find((v) => v.variantGid === selectedVariantGid);
            const sizeNote = selectedVariantObj && selectedVariantObj.title !== "Standard / One Size"
              ? ` for size "${selectedVariantObj.title}"`
              : "";
            showMessage("success", `🎉 You're entered${sizeNote}! Check your email when the draw completes.`);
            button.style.display = "none";
          }
        } catch (err) {
          console.error("Fairdrops entry error:", err);
          showMessage("error", "Network error submitting your entry. Please check your connection and try again.");
          setButtonLoading(false);
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
