
"use strict";

// ============================================================
// CLIMATIX — Dashboard frontend
// ============================================================

const $ = (id) => document.getElementById(id);

let lastStatus = {};
let chartHistory = [];
let settingsDirty = false;
let isSavingSettings = false;
let isConnecting = false;

let pollTimer = null;
let portsTimer = null;
let historyTimer = null;

const POLL_INTERVAL = 1000;
const PORTS_INTERVAL = 5000;
const HISTORY_INTERVAL = 2000;
const MAX_CHART_POINTS = 300;

// ============================================================
// API
// ============================================================

async function api(url, options = {}) {
  const response = await fetch(url, {
    headers: {
      "Content-Type": "application/json",
      ...(options.headers || {})
    },
    ...options
  });

  let result;

  try {
    result = await response.json();
  } catch {
    throw new Error(`Server returned HTTP ${response.status}`);
  }

  if (!response.ok) {
    throw new Error(
      result.error || result.message || `HTTP ${response.status}`
    );
  }

  return result;
}

// ============================================================
// Helpers
// ============================================================

function percent(value) {
  const number = Number(value) || 0;
  return Math.round(Math.max(0, Math.min(255, number)) / 255 * 100);
}

function formatUptime(milliseconds) {
  const totalSeconds = Math.max(
    0,
    Math.floor((Number(milliseconds) || 0) / 1000)
  );

  const days = Math.floor(totalSeconds / 86400);
  const hours = Math.floor((totalSeconds % 86400) / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;

  if (days > 0) {
    return `${days}d ${hours}h ${minutes}m`;
  }

  if (hours > 0) {
    return `${hours}h ${minutes}m ${seconds}s`;
  }

  if (minutes > 0) {
    return `${minutes}m ${seconds}s`;
  }

  return `${seconds}s`;
}

function showToast(message, type = "info") {
  let toast = $("toast");

  if (!toast) {
    toast = document.createElement("div");
    toast.id = "toast";

    Object.assign(toast.style, {
      position: "fixed",
      right: "24px",
      bottom: "24px",
      zIndex: "9999",
      maxWidth: "min(420px, calc(100vw - 32px))",
      padding: "14px 18px",
      borderRadius: "12px",
      background: "#101827",
      color: "#f1f5f9",
      border: "1px solid #29364b",
      boxShadow: "0 12px 40px rgba(0,0,0,.35)",
      fontSize: "14px",
      lineHeight: "1.5",
      opacity: "0",
      transform: "translateY(8px)",
      transition: "opacity .2s ease, transform .2s ease"
    });

    document.body.appendChild(toast);
  }

  const borderColors = {
    success: "#4cc9a0",
    error: "#ff647c",
    info: "#4cc9f0"
  };

  toast.textContent = message;
  toast.style.borderColor = borderColors[type] || borderColors.info;
  toast.style.opacity = "1";
  toast.style.transform = "translateY(0)";

  clearTimeout(toast._hideTimer);

  toast._hideTimer = setTimeout(() => {
    toast.style.opacity = "0";
    toast.style.transform = "translateY(8px)";
  }, 3500);
}

function setText(id, value) {
  const element = $(id);

  if (element) {
    element.textContent = value;
  }
}

function setWidth(id, value) {
  const element = $(id);

  if (element) {
    element.style.width = `${Math.max(0, Math.min(100, value))}%`;
  }
}

function setButtonLoading(button, loading, loadingText = "Please wait...") {
  if (!button) return;

  if (loading) {
    if (!button.dataset.originalText) {
      button.dataset.originalText = button.textContent;
    }

    button.disabled = true;
    button.textContent = loadingText;
  } else {
    button.disabled = false;

    if (button.dataset.originalText) {
      button.textContent = button.dataset.originalText;
      delete button.dataset.originalText;
    }
  }
}

// ============================================================
// Dashboard update
// ============================================================

function updateDashboard(data) {
  lastStatus = data;

  // connected  = stižu ispravne status poruke s ESP32
  // portOpen   = serijski port je otvoren (ESP32 možda još šuti)
  const connected = Boolean(data.connected);
  const portOpen = Boolean(data.port_open);
  const rxBytes = Number(data.rx_bytes) || 0;
  const sensorOk = Boolean(data.sensor_ok);
  const temperature = data.temperature;

  const valid =
    connected &&
    sensorOk &&
    temperature !== null &&
    temperature !== undefined &&
    Number.isFinite(Number(temperature));

  // Connection status
  setText(
    "connectionLabel",
    connected ? "Connected" : portOpen ? "Waiting for data" : "Disconnected"
  );

  const connectionDot = $("connectionDot");
  if (connectionDot) {
    connectionDot.className = `dot ${connected ? "online" : ""}`;
  }

  const statusBadge = $("statusBadge");
  if (statusBadge) {
    statusBadge.textContent = connected
      ? "ONLINE"
      : portOpen ? "NO DATA" : "OFFLINE";
    statusBadge.className = `badge ${connected ? "online" : ""}`;
  }

  setText(
    "deviceTitle",
    connected
      ? "ESP32 connected"
      : portOpen ? "Port open — waiting for ESP32" : "Waiting for ESP32"
  );

  let deviceMessage = "Connect your board using a USB data cable.";

  if (connected) {
    deviceMessage = `USB Serial · ${data.port || "Connected"} · 115200 baud`;
  } else if (portOpen && data.last_update) {
    deviceMessage = "No valid data from the ESP32 for several seconds.";
  } else if (portOpen && rxBytes === 0) {
    deviceMessage =
      `Port ${data.port || ""} is open but the ESP32 has sent nothing yet. ` +
      "Check that the firmware runs at 115200 baud and that no other " +
      "program (e.g. Arduino Serial Monitor) is using the port.";
  } else if (portOpen) {
    deviceMessage =
      `Receiving data (${rxBytes} bytes) but no valid status messages yet.`;
  }

  setText("deviceMessage", deviceMessage);

  const connectButton = $("connectButton");

  if (connectButton && !isConnecting) {
    connectButton.textContent = portOpen || connected
      ? "Disconnect"
      : "Connect device";
  }

  // Temperature
  setText(
    "temperature",
    valid ? Number(temperature).toFixed(1) : "--.-"
  );

  setText(
    "chartCurrent",
    valid ? `${Number(temperature).toFixed(1)} °C` : "--.- °C"
  );

  setText(
    "temperatureMessage",
    !connected
      ? "ESP32 not connected"
      : valid
        ? "Sensor reading available"
        : "Sensor error"
  );

  const temperaturePercent = valid
    ? Math.max(0, Math.min(100, (Number(temperature) + 10) / 50 * 100))
    : 0;

  setWidth("temperatureBar", temperaturePercent);

  // Motor PWM (the "%" sign is already in the HTML as <small>)
  [1, 2].forEach((number) => {
    const rawValue = Number(data[`motor${number}_pwm`] ?? 0);
    const pwm = Math.max(0, Math.min(255, rawValue));
    const pwmPercent = percent(pwm);

    setText(`motor${number}`, String(pwmPercent));
    setText(`motor${number}Raw`, `${pwm} / 255`);
    setWidth(`motor${number}Bar`, pwmPercent);
  });

  // Sensor state
  setText(
    "sensorState",
    !connected ? "Offline" : sensorOk ? "Healthy" : "Error"
  );

  const sensorDot = $("sensorDot");

  if (sensorDot) {
    sensorDot.className = `dot ${
      !connected ? "" : sensorOk ? "online" : "error"
    }`;
  }

  setText(
    "sensorMessage",
    !connected
      ? "Waiting for device"
      : sensorOk
        ? "Temperature readings are valid"
        : "Check DHT11 wiring and power"
  );

  // Diagnostics
  setText(
    "diagConnection",
    connected ? "Connected" : portOpen ? "Port open, no data" : "Offline"
  );
  setText(
    "diagSensor",
    connected && sensorOk ? "Healthy" : "Unavailable"
  );

  setText(
    "lastUpdate",
    data.last_update
      ? new Date(data.last_update).toLocaleTimeString()
      : "—"
  );

  setText(
    "uptime",
    connected ? formatUptime(data.uptime_ms) : "—"
  );

  // Settings: never overwrite fields while the user is editing.
  const focusedSetting = ["low", "high", "pwm"].includes(
    document.activeElement?.id
  );

  if (connected && !settingsDirty && !isSavingSettings && !focusedSetting) {
    if ($("low")) $("low").value = data.low_threshold ?? 10;
    if ($("high")) $("high").value = data.high_threshold ?? 12;
    if ($("pwm")) $("pwm").value = data.medium_pwm ?? 136;

    updatePreview();
  }

  // Active control rule
  let title = "Waiting for temperature";
  let description = "The active control rule will appear here.";

  if (!connected) {
    title = "Device disconnected";
    description = "Reconnect the ESP32 to resume monitoring.";
  } else if (!valid) {
    title = "Sensor error — motor stopped";
    description = "Firmware forces both PWM outputs to zero.";
  } else if (Number(temperature) < Number(data.low_threshold)) {
    title = "Motors stopped";
    description = "Temperature is below the lower threshold.";
  } else if (Number(temperature) < Number(data.high_threshold)) {
    title = "Medium speed";
    description =
      `Motor 1 is running at PWM ${data.medium_pwm}/255.`;
  } else {
    title = "Maximum speed";
    description = "Motor 1 is running at full PWM.";
  }

  setText("activeRule", title);
  setText("activeDescription", description);

  drawChart();
}

// ============================================================
// Temperature history and chart
// ============================================================

async function loadHistory() {
  try {
    const result = await api("/api/history");

    // The backend returns { "points": [...] }.
    const points = Array.isArray(result)
      ? result
      : result.points || result.history || result.data || [];

    chartHistory = points
      .filter((point) => {
        const temperature = Number(point.temperature);

        return (
          point.temperature !== null &&
          point.temperature !== undefined &&
          Number.isFinite(temperature)
        );
      })
      .slice(-MAX_CHART_POINTS);

    drawChart();
  } catch (error) {
    console.warn("Could not load temperature history:", error.message);
  }
}

function drawChart() {
  const canvas = $("chart");

  if (!canvas) return;

  const context = canvas.getContext("2d");
  if (!context) return;

  const rect = canvas.getBoundingClientRect();

  if (!rect.width || !rect.height) return;

  const pixelRatio = window.devicePixelRatio || 1;

  canvas.width = Math.round(rect.width * pixelRatio);
  canvas.height = Math.round(rect.height * pixelRatio);

  context.setTransform(pixelRatio, 0, 0, pixelRatio, 0, 0);

  const width = rect.width;
  const height = rect.height;

  context.clearRect(0, 0, width, height);

  const padding = {
    top: 18,
    right: 18,
    bottom: 30,
    left: 42
  };

  const plotWidth = width - padding.left - padding.right;
  const plotHeight = height - padding.top - padding.bottom;

  if (plotWidth <= 0 || plotHeight <= 0) return;

  const validPoints = chartHistory
    .filter((point) => point.temperature !== null)
    .map((point) => ({
      temperature: Number(point.temperature),
      timestamp: point.timestamp || point.time || point.created_at || null
    }))
    .filter((point) => Number.isFinite(point.temperature));

  // Add the current live reading if it isn't already the latest point.
  if (
    lastStatus.connected &&
    lastStatus.sensor_ok &&
    lastStatus.temperature !== null &&
    lastStatus.temperature !== undefined &&
    Number.isFinite(Number(lastStatus.temperature))
  ) {
    const latest = validPoints[validPoints.length - 1];
    const currentTemperature = Number(lastStatus.temperature);

    if (
      !latest ||
      latest.temperature !== currentTemperature
    ) {
      validPoints.push({
        temperature: currentTemperature,
        timestamp: Date.now()
      });
    }
  }

  const lowThreshold = Number(lastStatus.low_threshold ?? 10);
  const highThreshold = Number(lastStatus.high_threshold ?? 12);

  const values = validPoints.map((point) => point.temperature);

  values.push(lowThreshold, highThreshold);

  let minValue = Math.floor(Math.min(...values) - 2);
  let maxValue = Math.ceil(Math.max(...values) + 2);

  if (maxValue - minValue < 5) {
    minValue -= 2;
    maxValue += 2;
  }

  const xFor = (index) => {
    if (validPoints.length <= 1) {
      return padding.left + plotWidth / 2;
    }

    return padding.left +
      (index / (validPoints.length - 1)) * plotWidth;
  };

  const yFor = (value) => {
    return padding.top +
      ((maxValue - value) / (maxValue - minValue)) * plotHeight;
  };

  // Grid and temperature labels
  context.font = "11px Inter, system-ui, sans-serif";
  context.textAlign = "right";
  context.textBaseline = "middle";

  const gridLines = 5;

  for (let i = 0; i <= gridLines; i++) {
    const value = maxValue - (i / gridLines) * (maxValue - minValue);
    const y = padding.top + (i / gridLines) * plotHeight;

    context.beginPath();
    context.strokeStyle = "rgba(148, 163, 184, 0.13)";
    context.lineWidth = 1;
    context.moveTo(padding.left, y);
    context.lineTo(width - padding.right, y);
    context.stroke();

    context.fillStyle = "#8b98ad";
    context.fillText(`${value.toFixed(1)}°`, padding.left - 8, y);
  }

  // Threshold lines
  function drawThreshold(value, color, label) {
    if (value < minValue || value > maxValue) return;

    const y = yFor(value);

    context.save();
    context.setLineDash([5, 5]);
    context.strokeStyle = color;
    context.lineWidth = 1.2;

    context.beginPath();
    context.moveTo(padding.left, y);
    context.lineTo(width - padding.right, y);
    context.stroke();

    context.restore();

    context.fillStyle = color;
    context.textAlign = "left";
    context.textBaseline = "bottom";
    context.font = "10px Inter, system-ui, sans-serif";
    context.fillText(label, padding.left + 6, y - 3);
  }

  drawThreshold(lowThreshold, "#9b8afb", `LOW ${lowThreshold}°`);
  drawThreshold(highThreshold, "#ffb86b", `HIGH ${highThreshold}°`);

  // No history yet
  if (validPoints.length === 0) {
    context.fillStyle = "#8b98ad";
    context.textAlign = "center";
    context.textBaseline = "middle";
    context.font = "13px Inter, system-ui, sans-serif";
    context.fillText(
      "Waiting for temperature data…",
      padding.left + plotWidth / 2,
      padding.top + plotHeight / 2
    );

    return;
  }

  // Temperature area
  const gradient = context.createLinearGradient(
    0,
    padding.top,
    0,
    padding.top + plotHeight
  );

  gradient.addColorStop(0, "rgba(76, 201, 240, 0.24)");
  gradient.addColorStop(1, "rgba(76, 201, 240, 0.01)");

  context.beginPath();

  validPoints.forEach((point, index) => {
    const x = xFor(index);
    const y = yFor(point.temperature);

    if (index === 0) {
      context.moveTo(x, y);
    } else {
      context.lineTo(x, y);
    }
  });

  if (validPoints.length === 1) {
    const x = xFor(0);
    context.lineTo(x, yFor(validPoints[0].temperature));
  }

  context.lineTo(xFor(validPoints.length - 1), padding.top + plotHeight);
  context.lineTo(xFor(0), padding.top + plotHeight);
  context.closePath();

  context.fillStyle = gradient;
  context.fill();

  // Temperature line
  context.beginPath();

  validPoints.forEach((point, index) => {
    const x = xFor(index);
    const y = yFor(point.temperature);

    if (index === 0) {
      context.moveTo(x, y);
    } else {
      context.lineTo(x, y);
    }
  });

  context.strokeStyle = "#4cc9f0";
  context.lineWidth = 2.5;
  context.lineJoin = "round";
  context.lineCap = "round";
  context.stroke();

  // Latest point
  const lastIndex = validPoints.length - 1;
  const lastPoint = validPoints[lastIndex];

  context.beginPath();
  context.arc(xFor(lastIndex), yFor(lastPoint.temperature), 4, 0, Math.PI * 2);
  context.fillStyle = "#4cc9f0";
  context.fill();

  context.beginPath();
  context.arc(xFor(lastIndex), yFor(lastPoint.temperature), 7, 0, Math.PI * 2);
  context.strokeStyle = "rgba(76, 201, 240, 0.3)";
  context.lineWidth = 3;
  context.stroke();

  // Time labels
  context.fillStyle = "#8b98ad";
  context.font = "10px Inter, system-ui, sans-serif";
  context.textBaseline = "top";

  const firstTimestamp = validPoints[0].timestamp;
  const lastTimestamp = validPoints[lastIndex].timestamp;

  context.textAlign = "left";
  context.fillText(
    firstTimestamp ? formatChartTime(firstTimestamp) : "Oldest",
    padding.left,
    height - padding.bottom + 10
  );

  context.textAlign = "right";
  context.fillText(
    lastTimestamp ? formatChartTime(lastTimestamp) : "Latest",
    width - padding.right,
    height - padding.bottom + 10
  );
}

function formatChartTime(value) {
  const date = typeof value === "number"
    ? new Date(value < 1e12 ? value * 1000 : value)
    : new Date(value);

  if (Number.isNaN(date.getTime())) return "";

  return date.toLocaleTimeString([], {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit"
  });
}

// ============================================================
// Settings preview
// ============================================================

function updatePreview() {
  const low = Number($("low")?.value);
  const high = Number($("high")?.value);
  const pwm = Number($("pwm")?.value);

  if (Number.isFinite(pwm)) {
    setText("pwmLabel", `${Math.round(pwm)} / 255`);
    setText("mediumRule", `${percent(pwm)}% PWM`);
  }

  if (Number.isFinite(low) && Number.isFinite(high)) {
    setText("thresholdText", `${low}°C — ${high}°C`);
  }
}

// ============================================================
// Serial port selection
// ============================================================

async function loadPorts() {
  const selector = $("portSelect");
  if (!selector) return;

  try {
    const result = await api("/api/ports");
    const ports = Array.isArray(result)
      ? result
      : result.ports || [];

    const currentValue = selector.value;
    const currentPort = lastStatus.port;

    selector.replaceChildren();

    if (ports.length === 0) {
      const option = document.createElement("option");
      option.value = "";
      option.textContent = "No serial ports found";
      selector.appendChild(option);
      return;
    }

    ports.forEach((port) => {
      const device = typeof port === "string"
        ? port
        : port.device || port.port || "";

      if (!device) return;

      const option = document.createElement("option");
      option.value = device;
      option.textContent = typeof port === "string"
        ? port
        : `${device}${port.description ? ` — ${port.description}` : ""}`;

      selector.appendChild(option);
    });

    const desiredPort = currentPort || currentValue;

    if (
      desiredPort &&
      [...selector.options].some((option) => option.value === desiredPort)
    ) {
      selector.value = desiredPort;
    }
  } catch (error) {
    console.warn("Could not list serial ports:", error.message);
  }
}

// ============================================================
// Connect / disconnect
// ============================================================

async function toggleConnection() {
  if (isConnecting) return;

  // "Active" also covers an open port that has not sent data yet,
  // so the user can always disconnect.
  const active = Boolean(lastStatus.port_open || lastStatus.connected);
  const button = $("connectButton");

  isConnecting = true;

  if (button) {
    button.disabled = true;
    button.textContent = active ? "Disconnecting..." : "Connecting...";
  }

  try {
    if (active) {
      await api("/api/disconnect", {
        method: "POST",
        body: JSON.stringify({})
      });

      showToast("ESP32 disconnected.", "info");
    } else {
      const port = $("portSelect")?.value;

      if (!port) {
        showToast("Select an available serial port first.", "error");
        return;
      }

      await api("/api/connect", {
        method: "POST",
        body: JSON.stringify({ port })
      });

      settingsDirty = false;
      showToast(`Port ${port} opened. Waiting for the ESP32...`, "success");
    }

    await pollStatus();
    await loadPorts();
  } catch (error) {
    showToast(error.message || "Connection failed.", "error");
  } finally {
    isConnecting = false;

    if (button) {
      button.disabled = false;
      button.textContent = lastStatus.port_open || lastStatus.connected
        ? "Disconnect"
        : "Connect device";
    }
  }
}

// ============================================================
// Save settings
// ============================================================

async function saveSettings(event) {
  if (event) event.preventDefault();

  if (!lastStatus.connected) {
    showToast("Connect the ESP32 before changing settings.", "error");
    return;
  }

  const low = Number($("low")?.value);
  const high = Number($("high")?.value);
  const mediumPwm = Number($("pwm")?.value);

  if (
    !Number.isFinite(low) ||
    !Number.isFinite(high) ||
    !Number.isFinite(mediumPwm)
  ) {
    showToast("Enter valid numeric settings.", "error");
    return;
  }

  if (low < -20 || low > 60 || high < -20 || high > 60) {
    showToast("Temperature thresholds must be between -20 and 60 °C.", "error");
    return;
  }

  if (high <= low) {
    showToast("The upper threshold must be higher than the lower threshold.", "error");
    return;
  }

  if (!Number.isInteger(mediumPwm) || mediumPwm < 0 || mediumPwm > 255) {
    showToast("PWM must be an integer between 0 and 255.", "error");
    return;
  }

  const saveButton = $("applyButton");

  isSavingSettings = true;
  setButtonLoading(saveButton, true, "Applying...");

  try {
    // The backend expects low_threshold / high_threshold / medium_pwm.
    await api("/api/config", {
      method: "POST",
      body: JSON.stringify({
        low_threshold: low,
        high_threshold: high,
        medium_pwm: mediumPwm
      })
    });

    settingsDirty = false;

    showToast("Settings applied to the ESP32.", "success");

    await pollStatus();
  } catch (error) {
    showToast(error.message || "Could not apply settings.", "error");
  } finally {
    isSavingSettings = false;
    setButtonLoading(saveButton, false);
  }
}

// ============================================================
// Polling
// ============================================================

async function pollStatus() {
  try {
    const result = await api("/api/status");

    const data = result.status || result;
    updateDashboard(data);
  } catch (error) {
    console.warn("Status polling failed:", error.message);

    updateDashboard({
      ...lastStatus,
      connected: false,
      sensor_ok: false,
      temperature: null
    });
  }
}

function startPolling() {
  if (pollTimer) clearInterval(pollTimer);
  if (portsTimer) clearInterval(portsTimer);
  if (historyTimer) clearInterval(historyTimer);

  pollStatus();
  loadHistory();
  loadPorts();

  pollTimer = setInterval(pollStatus, POLL_INTERVAL);
  portsTimer = setInterval(loadPorts, PORTS_INTERVAL);
  historyTimer = setInterval(loadHistory, HISTORY_INTERVAL);
}

// ============================================================
// Event listeners
// ============================================================

function setupEventListeners() {
  $("connectButton")?.addEventListener("click", toggleConnection);
  $("refreshButton")?.addEventListener("click", loadPorts);

  // The form in index.html is "configForm"; its submit button is "applyButton".
  $("configForm")?.addEventListener("submit", saveSettings);

  ["low", "high", "pwm"].forEach((id) => {
    $(id)?.addEventListener("input", () => {
      settingsDirty = true;
      updatePreview();
    });
  });

  window.addEventListener("resize", drawChart);
  window.addEventListener("beforeunload", () => {
    if (pollTimer) clearInterval(pollTimer);
    if (portsTimer) clearInterval(portsTimer);
    if (historyTimer) clearInterval(historyTimer);
  });
}

// ============================================================
// Startup
// ============================================================

document.addEventListener("DOMContentLoaded", () => {
  setupEventListeners();
  updatePreview();
  startPolling();
});
