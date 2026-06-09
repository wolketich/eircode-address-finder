const AUTOADDRESS_KEY = (() => {
  if (typeof process !== "undefined" && process.env?.AUTOADDRESS_KEY) {
    return process.env.AUTOADDRESS_KEY;
  }
  return "9D3F13CF-DD01-FAED-F9DE-20FDAF06FD27";
})();
const AUTOADDRESS_URL = "https://api.autoaddress.ie/2.0/findaddress";
const MENU_ID = "lookup-selected-eircode";

chrome.runtime.onInstalled.addListener(() => {
  chrome.contextMenus.removeAll(() => {
    chrome.contextMenus.create({
      id: MENU_ID,
      title: "Find address for selected Eircode",
      contexts: ["selection"]
    });
  });
});

chrome.contextMenus.onClicked.addListener(async (info, tab) => {
  if (info.menuItemId !== MENU_ID || !tab?.id) return;
  await lookupSelectedText(info.selectionText || "", tab.id);
});

chrome.commands.onCommand.addListener(async (command, tab) => {
  if (command !== "lookup-selected-eircode" || !tab?.id) return;

  try {
    const results = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: () => String(window.getSelection ? window.getSelection().toString() : "")
    });

    const selectedText = results?.[0]?.result || "";
    await lookupSelectedText(selectedText, tab.id);
  } catch (error) {
    await showOverlay(tab.id, makeErrorPayload("Could not read selected text on this page.", String(error?.message || error)));
  }
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.type !== "manualLookup") return false;

  lookupAddress(message.eircode)
    .then((payload) => sendResponse({ ok: true, payload }))
    .catch((error) => sendResponse({ ok: false, error: String(error?.message || error) }));

  return true;
});

async function lookupSelectedText(rawText, tabId) {
  const eircode = extractEircode(rawText);

  if (!eircode) {
    await showOverlay(tabId, makeErrorPayload(
      "No valid Eircode selected.",
      "Highlight an Eircode like A98 A6F9 or A98A6F9, then right-click or press Alt + Shift + E."
    ));
    return;
  }

  await showOverlay(tabId, {
    status: "loading",
    title: "Finding address...",
    message: `Looking up ${formatEircode(eircode)}.`
  });

  try {
    const payload = await lookupAddress(eircode);
    await chrome.storage.local.set({ lastLookup: payload });
    await showOverlay(tabId, payload);
  } catch (error) {
    await showOverlay(tabId, makeErrorPayload("Could not find the address.", String(error?.message || error), eircode));
  }
}

async function lookupAddress(rawEircode) {
  const eircode = extractEircode(rawEircode);
  if (!eircode) {
    throw new Error("Enter a valid Eircode, for example A98 A6F9.");
  }

  const url = `${AUTOADDRESS_URL}?language=en&country=ie&key=${encodeURIComponent(AUTOADDRESS_KEY)}&address=${encodeURIComponent(eircode)}`;
  const response = await fetch(url, { method: "GET" });

  if (!response.ok) {
    throw new Error(`Autoaddress returned HTTP ${response.status}.`);
  }

  const data = await response.json();
  const payload = parseAutoaddressResponse(data, eircode);

  if (!payload.primaryAddress && payload.options.length === 0) {
    throw new Error(data?.result?.text || "No address found for this Eircode.");
  }

  return payload;
}

function parseAutoaddressResponse(data, searchedEircode) {
  const options = Array.isArray(data?.options)
    ? data.options.map((option, index) => ({
        index: index + 1,
        displayName: option?.displayName || "",
        addressId: option?.addressId || null,
        addressType: option?.addressType?.text || "",
        optionType: option?.optionType?.text || ""
      })).filter((option) => option.displayName)
    : [];

  const postalAddressLines = Array.isArray(data?.postalAddress) ? data.postalAddress.filter(Boolean) : [];
  const primaryAddress = postalAddressLines.length ? postalAddressLines.join(", ") : (options[0]?.displayName || "");
  const postcode = data?.postcode || searchedEircode;
  const mapQuery = primaryAddress || postcode;

  return {
    status: "success",
    title: "Address found",
    searchedEircode: formatEircode(searchedEircode),
    postcode: postcode ? formatEircode(postcode) : "",
    primaryAddress,
    postalAddressLines,
    googleMapsUrl: `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(mapQuery)}`,
    resultCode: data?.result?.code ?? null,
    resultText: data?.result?.text || "",
    isUniqueAddress: Boolean(data?.isUniqueAddress),
    addressId: data?.addressId || options[0]?.addressId || null,
    addressType: data?.addressType?.text || options[0]?.addressType || "",
    matchLevel: data?.matchLevel?.text || "",
    totalOptions: Number.isFinite(data?.totalOptions) ? data.totalOptions : options.length,
    options,
    lookedUpAt: new Date().toISOString()
  };
}

function extractEircode(value) {
  const text = String(value || "").toUpperCase();
  const match = text.match(/[A-Z]\d{2}\s?[A-Z0-9]{4}/);
  if (!match) return "";
  return match[0].replace(/\s+/g, "");
}

function formatEircode(value) {
  const cleaned = String(value || "").toUpperCase().replace(/\s+/g, "");
  if (cleaned.length !== 7) return cleaned;
  return `${cleaned.slice(0, 3)} ${cleaned.slice(3)}`;
}

function makeErrorPayload(title, message, eircode = "") {
  return {
    status: "error",
    title,
    message,
    searchedEircode: eircode ? formatEircode(eircode) : ""
  };
}

async function showOverlay(tabId, payload) {
  await chrome.scripting.executeScript({
    target: { tabId },
    func: renderEircodeOverlay,
    args: [payload]
  });
}

function renderEircodeOverlay(payload) {
  const existing = document.getElementById("eircode-address-finder-overlay");
  if (existing) existing.remove();

  const host = document.createElement("div");
  host.id = "eircode-address-finder-overlay";
  host.style.position = "fixed";
  host.style.zIndex = "2147483647";
  host.style.top = "18px";
  host.style.right = "18px";
  document.documentElement.appendChild(host);

  const shadow = host.attachShadow({ mode: "open" });

  const style = document.createElement("style");
  style.textContent = `
    * { box-sizing: border-box; }
    .card {
      width: min(430px, calc(100vw - 36px));
      max-height: calc(100vh - 36px);
      overflow: auto;
      font-family: Arial, Helvetica, sans-serif;
      color: #172033;
      background: #fff;
      border: 1px solid #d7dce5;
      border-radius: 14px;
      box-shadow: 0 18px 50px rgba(15, 23, 42, 0.25);
      padding: 16px;
    }
    .top { display: flex; justify-content: space-between; align-items: flex-start; gap: 12px; margin-bottom: 12px; }
    .brand { font-size: 12px; color: #64748b; margin-bottom: 4px; }
    .title { font-size: 18px; font-weight: 700; line-height: 1.25; }
    .close {
      border: none; background: #f1f5f9; color: #0f172a; cursor: pointer;
      width: 32px; height: 32px; border-radius: 999px; font-size: 20px; line-height: 1;
    }
    .close:hover { background: #e2e8f0; }
    .status {
      display: inline-block; margin: 4px 0 12px; padding: 4px 9px; border-radius: 999px;
      font-size: 12px; font-weight: 700;
    }
    .success { background: #dcfce7; color: #166534; }
    .error { background: #fee2e2; color: #991b1b; }
    .loading { background: #e0f2fe; color: #075985; }
    .label { font-size: 12px; font-weight: 700; color: #475569; margin-bottom: 6px; }
    .address {
      background: #f8fafc; border: 1px solid #e2e8f0; border-radius: 12px;
      padding: 12px; font-size: 15px; line-height: 1.45; margin-bottom: 12px;
    }
    .message { font-size: 14px; line-height: 1.45; margin-bottom: 12px; }
    .grid { display: grid; grid-template-columns: 120px 1fr; gap: 8px 10px; margin: 12px 0; font-size: 13px; }
    .key { color: #64748b; }
    .value { color: #0f172a; font-weight: 600; overflow-wrap: anywhere; }
    .buttons { display: flex; flex-wrap: wrap; gap: 8px; margin-top: 12px; }
    button.action, a.action {
      border: 1px solid #cbd5e1; background: #fff; color: #0f172a; cursor: pointer;
      text-decoration: none; padding: 9px 11px; border-radius: 10px; font-size: 13px; font-weight: 700;
      display: inline-flex; align-items: center; justify-content: center;
    }
    .primary { background: #0f172a !important; color: #fff !important; border-color: #0f172a !important; }
    button.action:hover, a.action:hover { background: #f1f5f9; }
    .primary:hover { background: #1e293b !important; }
    .options { margin-top: 14px; border-top: 1px solid #e2e8f0; padding-top: 12px; }
    .option { border: 1px solid #e2e8f0; border-radius: 10px; padding: 10px; margin-top: 8px; }
    .option-title { font-size: 13px; line-height: 1.4; font-weight: 700; margin-bottom: 8px; }
    .option-meta { font-size: 12px; color: #64748b; margin-bottom: 8px; }
    .small { font-size: 12px; color: #64748b; margin-top: 10px; line-height: 1.4; }
  `;
  shadow.appendChild(style);

  const card = document.createElement("div");
  card.className = "card";
  shadow.appendChild(card);

  const top = document.createElement("div");
  top.className = "top";
  card.appendChild(top);

  const headingWrap = document.createElement("div");
  top.appendChild(headingWrap);

  const brand = document.createElement("div");
  brand.className = "brand";
  brand.textContent = "Eircode Address Finder";
  headingWrap.appendChild(brand);

  const title = document.createElement("div");
  title.className = "title";
  title.textContent = payload.title || "Lookup result";
  headingWrap.appendChild(title);

  const close = document.createElement("button");
  close.className = "close";
  close.type = "button";
  close.textContent = "×";
  close.title = "Close";
  close.addEventListener("click", () => host.remove());
  top.appendChild(close);

  const badge = document.createElement("div");
  badge.className = `status ${payload.status || "success"}`;
  badge.textContent = payload.status === "loading" ? "Loading" : payload.status === "error" ? "Issue" : "Found";
  card.appendChild(badge);

  if (payload.status === "loading" || payload.status === "error") {
    const message = document.createElement("div");
    message.className = "message";
    message.textContent = payload.message || "";
    card.appendChild(message);

    if (payload.searchedEircode) {
      card.appendChild(detailGrid([
        ["Eircode", payload.searchedEircode]
      ]));
    }
    return;
  }

  const label = document.createElement("div");
  label.className = "label";
  label.textContent = "Okay, this is the address:";
  card.appendChild(label);

  const addressBox = document.createElement("div");
  addressBox.className = "address";
  addressBox.textContent = payload.primaryAddress || "No address returned.";
  card.appendChild(addressBox);

  card.appendChild(detailGrid([
    ["Eircode", payload.postcode || payload.searchedEircode || ""],
    ["Address ID", payload.addressId || ""],
    ["Address type", payload.addressType || ""],
    ["Match level", payload.matchLevel || ""],
    ["Unique address", payload.isUniqueAddress ? "Yes" : "No"],
    ["Options", String(payload.totalOptions ?? payload.options?.length ?? 0)],
    ["Result", payload.resultText || ""]
  ].filter((row) => row[1] !== "" && row[1] !== null && row[1] !== undefined)));

  const buttons = document.createElement("div");
  buttons.className = "buttons";
  card.appendChild(buttons);

  const mapButton = document.createElement("a");
  mapButton.className = "action primary";
  mapButton.textContent = "Open Google Maps";
  mapButton.href = payload.googleMapsUrl || `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(payload.primaryAddress || payload.postcode || "")}`;
  mapButton.target = "_blank";
  mapButton.rel = "noopener noreferrer";
  buttons.appendChild(mapButton);

  const copyAddress = document.createElement("button");
  copyAddress.className = "action";
  copyAddress.type = "button";
  copyAddress.textContent = "Copy address";
  copyAddress.addEventListener("click", async () => {
    await copyText(payload.primaryAddress || "");
    copyAddress.textContent = "Copied";
    setTimeout(() => copyAddress.textContent = "Copy address", 1200);
  });
  buttons.appendChild(copyAddress);

  const copyEircode = document.createElement("button");
  copyEircode.className = "action";
  copyEircode.type = "button";
  copyEircode.textContent = "Copy Eircode";
  copyEircode.addEventListener("click", async () => {
    await copyText(payload.postcode || payload.searchedEircode || "");
    copyEircode.textContent = "Copied";
    setTimeout(() => copyEircode.textContent = "Copy Eircode", 1200);
  });
  buttons.appendChild(copyEircode);

  const closeButton = document.createElement("button");
  closeButton.className = "action";
  closeButton.type = "button";
  closeButton.textContent = "Close";
  closeButton.addEventListener("click", () => host.remove());
  buttons.appendChild(closeButton);

  if (Array.isArray(payload.options) && payload.options.length > 0) {
    const optionsWrap = document.createElement("div");
    optionsWrap.className = "options";
    card.appendChild(optionsWrap);

    const optionsLabel = document.createElement("div");
    optionsLabel.className = "label";
    optionsLabel.textContent = "Matching options";
    optionsWrap.appendChild(optionsLabel);

    payload.options.slice(0, 5).forEach((option) => {
      const optionBox = document.createElement("div");
      optionBox.className = "option";
      optionsWrap.appendChild(optionBox);

      const optionTitle = document.createElement("div");
      optionTitle.className = "option-title";
      optionTitle.textContent = option.displayName;
      optionBox.appendChild(optionTitle);

      const optionMeta = document.createElement("div");
      optionMeta.className = "option-meta";
      optionMeta.textContent = [option.addressType, option.addressId ? `ID ${option.addressId}` : ""].filter(Boolean).join(" · ");
      optionBox.appendChild(optionMeta);

      const optionButtons = document.createElement("div");
      optionButtons.className = "buttons";
      optionBox.appendChild(optionButtons);

      const optionMap = document.createElement("a");
      optionMap.className = "action";
      optionMap.textContent = "Open this in Maps";
      optionMap.href = `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(option.displayName)}`;
      optionMap.target = "_blank";
      optionMap.rel = "noopener noreferrer";
      optionButtons.appendChild(optionMap);

      const optionCopy = document.createElement("button");
      optionCopy.className = "action";
      optionCopy.type = "button";
      optionCopy.textContent = "Copy";
      optionCopy.addEventListener("click", async () => {
        await copyText(option.displayName || "");
        optionCopy.textContent = "Copied";
        setTimeout(() => optionCopy.textContent = "Copy", 1200);
      });
      optionButtons.appendChild(optionCopy);
    });
  }

  const note = document.createElement("div");
  note.className = "small";
  note.textContent = "Shortcut: highlight an Eircode and press Alt + Shift + E.";
  card.appendChild(note);

  function detailGrid(rows) {
    const grid = document.createElement("div");
    grid.className = "grid";
    rows.forEach(([key, value]) => {
      const keyEl = document.createElement("div");
      keyEl.className = "key";
      keyEl.textContent = key;
      grid.appendChild(keyEl);

      const valueEl = document.createElement("div");
      valueEl.className = "value";
      valueEl.textContent = String(value);
      grid.appendChild(valueEl);
    });
    return grid;
  }

  async function copyText(text) {
    if (!text) return;
    try {
      await navigator.clipboard.writeText(text);
    } catch (_) {
      const textarea = document.createElement("textarea");
      textarea.value = text;
      textarea.style.position = "fixed";
      textarea.style.left = "-9999px";
      document.body.appendChild(textarea);
      textarea.focus();
      textarea.select();
      document.execCommand("copy");
      textarea.remove();
    }
  }
}
