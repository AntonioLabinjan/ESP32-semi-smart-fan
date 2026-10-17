
import json
import math
import queue
import threading
import time

import serial
from serial.tools import list_ports
from flask import Flask, jsonify, render_template_string, request

app = Flask(__name__)

BAUD = 115200
READ_TIMEOUT = 0.1
STALE_AFTER = 5.0
ACK_TIMEOUT = 2.0

serial_lock = threading.RLock()
state_lock = threading.Lock()
config_lock = threading.Lock()

connection = None
selected_port = None
last_message = 0.0
ack_queue = queue.Queue()

state = {
    "temperature": None,
    "sensor_ok": False,
    "threshold": 22.0,
    "fan_on": False,
    "connected": False,
}

HTML = r"""
<!DOCTYPE html>
<html lang="hr">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>CLIMATIX</title>
<style>
* { box-sizing: border-box; }
body {
    margin: 0;
    min-height: 100vh;
    display: grid;
    place-items: center;
    background: #10131b;
    color: #edf2f7;
    font-family: Inter, system-ui, sans-serif;
}
main {
    width: min(420px, 92vw);
    padding: 28px;
    background: #1a1f2b;
    border: 1px solid #303849;
    border-radius: 16px;
}
h1 { margin: 0 0 6px; font-size: 26px; }
.muted { color: #9ca9bc; font-size: 14px; }
.status { margin: 18px 0; font-size: 14px; }
.dot {
    display: inline-block;
    width: 8px;
    height: 8px;
    margin-right: 7px;
    border-radius: 50%;
    background: #687386;
}
.dot.online { background: #4cc9f0; }
.temperature {
    margin: 24px 0;
    font-size: 56px;
    font-weight: 700;
    letter-spacing: -2px;
}
.temperature small { font-size: 24px; color: #9ca9bc; }
label { display: block; margin-bottom: 8px; font-size: 14px; }
input, select, button {
    width: 100%;
    padding: 12px;
    border: 1px solid #394357;
    border-radius: 8px;
    background: #111620;
    color: #edf2f7;
    font: inherit;
}
button {
    margin-top: 10px;
    border: 0;
    background: #4361ee;
    cursor: pointer;
    font-weight: 600;
}
button:disabled { opacity: .5; cursor: not-allowed; }
.section { margin-top: 18px; }
.fan { margin-top: 18px; font-size: 14px; }
#message { min-height: 20px; margin-top: 12px; font-size: 13px; color: #4cc9f0; }
</style>
</head>
<body>
<main>
    <h1>CLIMATIX</h1>
    <div class="muted">ESP32 temperature control</div>

    <div class="status">
        <span id="dot" class="dot"></span><span id="connection">Disconnected</span>
    </div>

    <label for="port">Serial port</label>
    <select id="port"></select>
    <button id="connect">Connect</button>

    <div class="temperature">
        <span id="temperature">--.-</span><small> °C</small>
    </div>

    <div class="muted" id="sensor">Waiting for sensor...</div>

    <div class="section">
        <label for="threshold">Temperature threshold (°C)</label>
        <input id="threshold" type="number" min="-20" max="60"
               step="0.5" value="22">
        <button id="save" disabled>Save threshold</button>
    </div>

    <div class="fan">Fan: <strong id="fan">Unknown</strong></div>
    <div id="message"></div>
</main>

<script>
const $ = id => document.getElementById(id);

async function api(url, options = {}) {
    const response = await fetch(url, {
        headers: { "Content-Type": "application/json" },
        ...options
    });

    const data = await response.json();

    if (!response.ok) {
        throw new Error(data.error || "Request failed");
    }

    return data;
}

async function loadPorts() {
    try {
        const data = await api("/api/ports");
        const select = $("port");
        const previous = data.selected || select.value;

        select.innerHTML = data.ports.map(p =>
            `<option value="${p.device}">${p.device} — ${p.description}</option>`
        ).join("");

        if (previous && [...select.options].some(o => o.value === previous)) {
            select.value = previous;
        }
    } catch (error) {
        $("message").textContent = error.message;
    }
}

$("connect").addEventListener("click", async () => {
    try {
        const port = $("port").value;
        if (!port) throw new Error("No serial port found.");

        $("message").textContent = "Connecting...";
        await api("/api/connect", {
            method: "POST",
            body: JSON.stringify({ port })
        });
        $("message").textContent = "Port opened. Waiting for ESP32...";
    } catch (error) {
        $("message").textContent = error.message;
    }
});

$("save").addEventListener("click", async () => {
    const threshold = Number($("threshold").value);

    if (!Number.isFinite(threshold) || threshold < -20 || threshold > 60) {
        $("message").textContent = "Enter a threshold between -20 and 60 °C.";
        return;
    }

    $("save").disabled = true;
    $("message").textContent = "Saving...";

    try {
        await api("/api/config", {
            method: "POST",
            body: JSON.stringify({ threshold })
        });
        $("message").textContent = "Threshold applied on ESP32.";
    } catch (error) {
        $("message").textContent = error.message;
    } finally {
        $("save").disabled = false;
    }
});

async function updateStatus() {
    try {
        const s = await api("/api/status");

        $("dot").classList.toggle("online", s.connected);
        $("connection").textContent = s.connected
            ? `Connected${s.port ? " — " + s.port : ""}`
            : "Disconnected";

        $("temperature").textContent =
            s.sensor_ok && s.temperature !== null
                ? Number(s.temperature).toFixed(1)
                : "--.-";

        $("sensor").textContent = s.sensor_ok
            ? "Temperature sensor OK"
            : (s.connected ? "Waiting for valid sensor reading..." : "Waiting for ESP32...");

        $("fan").textContent = s.fan_on ? "ON" : "OFF";
        $("threshold").placeholder = s.threshold;
        $("save").disabled = !s.connected;

        if (document.activeElement !== $("threshold")) {
            $("threshold").value = s.threshold;
        }
    } catch (error) {
        $("message").textContent = error.message;
    }
}

loadPorts();
updateStatus();
setInterval(updateStatus, 1500);
setInterval(loadPorts, 5000);
</script>
</body>
</html>
"""


def process_line(raw):
    global last_message

    try:
        data = json.loads(raw.decode("utf-8", errors="replace").strip())
    except (json.JSONDecodeError, UnicodeDecodeError):
        return

    if not isinstance(data, dict):
        return

    if data.get("type") == "ack":
        ack_queue.put(data)
        return

    if data.get("type") != "status":
        return

    with state_lock:
        for key in ("temperature", "sensor_ok", "threshold", "fan_on"):
            if key in data:
                state[key] = data[key]

        state["connected"] = True
        last_message = time.monotonic()


def serial_reader():
    global connection, selected_port

    active = None
    pending = bytearray()

    while True:
        try:
            with serial_lock:
                conn = connection
                chunk = b""

                if conn and conn.is_open and conn.in_waiting:
                    chunk = conn.read(min(conn.in_waiting, 4096))

            if not conn or not conn.is_open:
                active = None
                pending.clear()
                time.sleep(0.1)
                continue

            if conn is not active:
                active = conn
                pending.clear()

            if not chunk:
                time.sleep(0.02)
                continue

            pending.extend(chunk)

            while b"\n" in pending:
                raw, _, rest = pending.partition(b"\n")
                pending = bytearray(rest)

                with serial_lock:
                    if connection is not conn:
                        pending.clear()
                        break
                    process_line(raw)

            if len(pending) > 8192:
                pending.clear()

        except (serial.SerialException, OSError, TypeError, ValueError) as exc:
            print(f"[SERIAL] {exc}")

            with serial_lock:
                if connection is conn:
                    try:
                        connection.close()
                    except Exception:
                        pass
                    connection = None
                    selected_port = None

            with state_lock:
                state["connected"] = False
                state["sensor_ok"] = False

            time.sleep(0.2)


@app.route("/")
def index():
    return render_template_string(HTML)


@app.route("/api/ports")
def ports():
    with serial_lock:
        selected = selected_port

    return jsonify({
        "ports": [
            {"device": p.device, "description": p.description}
            for p in list_ports.comports()
        ],
        "selected": selected,
    })


@app.route("/api/connect", methods=["POST"])
def connect():
    global connection, selected_port, last_message

    port = str((request.get_json(silent=True) or {}).get("port", "")).strip()
    if not port:
        return jsonify({"error": "Select a serial port."}), 400

    new_conn = None

    try:
        new_conn = serial.Serial(
            port=None,
            baudrate=BAUD,
            timeout=READ_TIMEOUT,
            write_timeout=2,
        )
        new_conn.port = port
        new_conn.dtr = False
        new_conn.rts = False

        with serial_lock:
            old = connection
            connection = None

            if old is not None:
                try:
                    old.close()
                except (serial.SerialException, OSError):
                    pass

            new_conn.open()
            connection = new_conn
            selected_port = port

        with state_lock:
            state.update({
                "temperature": None,
                "sensor_ok": False,
                "connected": False,
                "fan_on": False,
            })
            last_message = 0.0

        while True:
            try:
                ack_queue.get_nowait()
            except queue.Empty:
                break

        print(f"[SERIAL] Connected: {port} @ {BAUD}")
        return jsonify({"ok": True})

    except (serial.SerialException, OSError, ValueError) as exc:
        if new_conn is not None:
            try:
                new_conn.close()
            except Exception:
                pass
        return jsonify({"error": str(exc)}), 400


@app.route("/api/status")
def status():
    with state_lock:
        result = dict(state)
        age = time.monotonic() - last_message if last_message else None

    result["connected"] = age is not None and age < STALE_AFTER

    with serial_lock:
        result["port"] = selected_port

    return jsonify(result)


@app.route("/api/config", methods=["POST"])
def config():
    body = request.get_json(silent=True) or {}

    try:
        threshold = float(body["threshold"])
        if not math.isfinite(threshold) or not -20 <= threshold <= 60:
            raise ValueError
    except (KeyError, TypeError, ValueError):
        return jsonify({"error": "Threshold must be between -20 and 60 °C."}), 400

    with config_lock:
        while True:
            try:
                ack_queue.get_nowait()
            except queue.Empty:
                break

        try:
            with serial_lock:
                conn = connection
                if conn is None or not conn.is_open:
                    return jsonify({"error": "ESP32 is not connected."}), 503

                command = {
                    "cmd": "set_threshold",
                    "threshold": threshold,
                }
                conn.write((json.dumps(command, separators=(",", ":")) + "\n").encode())
                conn.flush()

            try:
                ack = ack_queue.get(timeout=ACK_TIMEOUT)
            except queue.Empty:
                return jsonify({"error": "ESP32 did not acknowledge the threshold."}), 504

            if not ack.get("ok"):
                return jsonify({"error": "ESP32 rejected the threshold."}), 400

            with state_lock:
                state["threshold"] = float(ack.get("threshold", threshold))

            return jsonify({"ok": True, "threshold": threshold})

        except (serial.SerialException, OSError) as exc:
            return jsonify({"error": str(exc)}), 503


@app.route("/api/disconnect", methods=["POST"])
def disconnect():
    global connection, selected_port, last_message

    with serial_lock:
        old = connection
        connection = None
        selected_port = None

        if old is not None:
            try:
                old.close()
            except (serial.SerialException, OSError):
                pass

    with state_lock:
        state["connected"] = False
        state["sensor_ok"] = False
        last_message = 0.0

    return jsonify({"ok": True})


if __name__ == "__main__":
    threading.Thread(target=serial_reader, daemon=True).start()
    print("CLIMATIX: http://127.0.0.1:5000")
    app.run(host="127.0.0.1", port=5000, debug=False, threaded=True)
