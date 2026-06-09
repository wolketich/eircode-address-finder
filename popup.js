const form = document.getElementById("lookupForm");
const input = document.getElementById("eircodeInput");
const statusEl = document.getElementById("status");
const resultEl = document.getElementById("result");
const addressEl = document.getElementById("address");
const metaEl = document.getElementById("meta");
const mapsEl = document.getElementById("maps");
const copyAddressEl = document.getElementById("copyAddress");

let currentAddress = "";

chrome.storage.local.get("lastLookup", ({ lastLookup }) => {
  if (lastLookup) renderResult(lastLookup);
});

form.addEventListener("submit", async (event) => {
  event.preventDefault();
  const eircode = input.value.trim();
  if (!eircode) {
    statusEl.textContent = "Enter an Eircode first.";
    return;
  }

  statusEl.textContent = "Finding address...";

  chrome.runtime.sendMessage({ type: "manualLookup", eircode }, (response) => {
    if (!response?.ok) {
      statusEl.textContent = response?.error || "Could not find address.";
      return;
    }

    chrome.storage.local.set({ lastLookup: response.payload });
    renderResult(response.payload);
    statusEl.textContent = "Address found.";
  });
});

copyAddressEl.addEventListener("click", async () => {
  if (!currentAddress) return;
  await navigator.clipboard.writeText(currentAddress);
  copyAddressEl.textContent = "Copied";
  setTimeout(() => copyAddressEl.textContent = "Copy address", 1200);
});

function renderResult(payload) {
  currentAddress = payload.primaryAddress || "";
  resultEl.classList.remove("hidden");
  addressEl.textContent = currentAddress || "No address saved yet.";
  mapsEl.href = payload.googleMapsUrl || `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(currentAddress)}`;

  const meta = [];
  if (payload.postcode) meta.push(`Eircode: ${payload.postcode}`);
  if (payload.addressId) meta.push(`Address ID: ${payload.addressId}`);
  if (payload.addressType) meta.push(`Type: ${payload.addressType}`);
  if (payload.matchLevel) meta.push(`Match: ${payload.matchLevel}`);
  metaEl.textContent = meta.join(" · ");
}
