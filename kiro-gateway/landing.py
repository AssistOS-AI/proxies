#!/usr/bin/env python3
"""
Kiro Gateway - Simple landing page with auto-device-flow authentication.
"""

import os
import json
import subprocess
import threading
import sqlite3
import http.client
import re
import time
from http.server import HTTPServer, BaseHTTPRequestHandler
from urllib.parse import urlparse
import signal
import sys

# Force unbuffered output
sys.stdout.reconfigure(line_buffering=True)
sys.stderr.reconfigure(line_buffering=True)

def log(msg):
    """Print with flush for container logs."""
    print(f"[landing] {msg}", flush=True)

KIRO_DB = "/root/.local/share/kiro-cli/data.sqlite3"
PORT = int(os.environ.get("PROXY_PORT", "8000"))
API_KEY = os.environ.get("PROXY_API_KEY", "kiro-gateway-key")
BACKEND_PORT = 18000

# State
backend_process = None
auth_state = {
    "active": False,
    "verification_url": None,
    "user_code": None,
    "error": None,
    "last_attempt": 0
}

def has_credentials():
    """Check if Kiro credentials exist."""
    if os.path.exists(KIRO_DB):
        try:
            conn = sqlite3.connect(KIRO_DB)
            cursor = conn.cursor()
            # New kiro-cli uses auth_kv table with key-value pairs
            # Check for token in the new schema
            cursor.execute("SELECT COUNT(*) FROM auth_kv WHERE key = 'kirocli:odic:token'")
            count = cursor.fetchone()[0]
            conn.close()
            return count > 0
        except Exception as e:
            # Fallback: try old schema
            try:
                cursor.execute("SELECT COUNT(*) FROM tokens WHERE refresh_token IS NOT NULL")
                count = cursor.fetchone()[0]
                conn.close()
                return count > 0
            except:
                pass
    return False

def is_backend_running():
    global backend_process
    return backend_process is not None and backend_process.poll() is None

def start_backend():
    global backend_process
    if is_backend_running():
        return True
    if not has_credentials():
        log("Cannot start backend: no credentials")
        return False
    
    env = os.environ.copy()
    env["SERVER_PORT"] = str(BACKEND_PORT)  # main.py uses SERVER_PORT, not PROXY_PORT
    
    log(f"Starting backend on port {BACKEND_PORT}...")
    
    try:
        # Don't capture stdout - let it go to container logs
        # Capturing with PIPE without reading causes the process to block
        backend_process = subprocess.Popen(
            ["python", "/app/main.py", "--port", str(BACKEND_PORT)],
            env=env,
            stdout=None,  # Inherit stdout (goes to container logs)
            stderr=None   # Inherit stderr
        )
        time.sleep(3)  # Give uvicorn time to start
        if is_backend_running():
            log(f"Backend started successfully (PID {backend_process.pid})")
            return True
        else:
            log(f"Backend process exited with code: {backend_process.poll()}")
            return False
    except Exception as e:
        log(f"Failed to start backend: {e}")
        return False

def start_device_flow():
    """Start Kiro device flow authentication using unbuffer for pseudo-TTY."""
    global auth_state
    
    # Don't start if already active
    if auth_state["active"]:
        return
    
    # Don't start if we already have a verification URL waiting (user hasn't logged in yet)
    # Only restart if it's been more than 10 minutes (device codes expire)
    if auth_state["verification_url"] and (time.time() - auth_state["last_attempt"]) < 600:
        log(f"Verification URL already available, not restarting device flow")
        return
    
    # Prevent rapid retries (5 second cooldown)
    if (time.time() - auth_state["last_attempt"]) < 5:
        return
    
    auth_state["active"] = True
    auth_state["error"] = None
    auth_state["last_attempt"] = time.time()
    # Don't clear verification_url/user_code here - they persist
    
    def run_login():
        global auth_state
        log("Starting device flow login...")
        
        # Clear old URL/code only when starting fresh
        auth_state["verification_url"] = None
        auth_state["user_code"] = None
        
        try:
            import pty
            cmd = [
                "kiro-cli", "login",
                "--license", "pro",
                "--identity-provider", "https://view.awsapps.com/start",
                "--region", "us-east-1",
                "--use-device-flow"
            ]
            log(f"Running: {' '.join(cmd)}")

            # Use a real pseudo-TTY so kiro-cli's isatty() check passes
            master_fd, slave_fd = pty.openpty()
            proc = subprocess.Popen(
                cmd,
                stdout=slave_fd,
                stderr=slave_fd,
                stdin=slave_fd,
                close_fds=True,
            )
            os.close(slave_fd)
            
            # Read output from the PTY master fd
            output = ""
            import select
            while True:
                # Check if process is done
                if proc.poll() is not None:
                    # Drain remaining output
                    try:
                        while select.select([master_fd], [], [], 0.1)[0]:
                            chunk = os.read(master_fd, 4096).decode('utf-8', errors='replace')
                            if not chunk:
                                break
                            output += chunk
                    except OSError:
                        pass
                    break

                # Wait for output with timeout
                try:
                    ready, _, _ = select.select([master_fd], [], [], 1.0)
                    if ready:
                        chunk = os.read(master_fd, 4096).decode('utf-8', errors='replace')
                        if not chunk:
                            break
                        output += chunk

                        # Auto-confirm pre-filled prompts by sending Enter
                        clean_chunk = re.sub(r'\x1b\[[0-9;]*[a-zA-Z]', '', chunk)
                        if '? Enter Start URL' in clean_chunk or '? Enter Region' in clean_chunk:
                            time.sleep(0.3)
                            try:
                                os.write(master_fd, b'\n')
                                log("Auto-confirmed prompt with Enter")
                            except OSError:
                                pass

                        # Process each line for URLs and codes
                        for line in chunk.split('\n'):
                            stripped = line.strip()
                            if stripped and not stripped.startswith('▰') and not stripped.startswith('▱'):
                                # Strip ANSI escape codes for logging
                                clean = re.sub(r'\x1b\[[0-9;]*[a-zA-Z]', '', stripped)
                                if clean.strip():
                                    log(f"kiro-cli: {clean.strip()}")

                            # Extract verification URL
                            urls = re.findall(r'https://[^\s\]\)\'"<>]+', line)
                            for url in urls:
                                url = url.rstrip('.,;:')
                                if 'device' in url.lower() or 'activate' in url.lower() or 'oidc' in url.lower():
                                    auth_state["verification_url"] = url
                                    log(f"Found verification URL: {url}")

                            # Extract user code
                            code_match = re.search(r'(?:code|Code|CODE)[:\s]+([A-Z0-9]{4,}[-]?[A-Z0-9]*)', line)
                            if code_match:
                                auth_state["user_code"] = code_match.group(1)
                                log(f"Found user code: {code_match.group(1)}")
                            if not auth_state["user_code"]:
                                standalone_code = re.search(r'\b([A-Z0-9]{4}-[A-Z0-9]{4})\b', line)
                                if standalone_code:
                                    auth_state["user_code"] = standalone_code.group(1)
                                    log(f"Found standalone code: {standalone_code.group(1)}")
                except OSError:
                    break

            os.close(master_fd)
            ret = proc.wait(timeout=300)
            log(f"kiro-cli exited with code: {ret}")
            auth_state["active"] = False
            
            if has_credentials():
                log("Authentication successful!")
                # Clear the device flow state on success
                auth_state["verification_url"] = None
                auth_state["user_code"] = None
                start_backend()
            else:
                # Don't set error if we have a verification URL (user just didn't complete in time)
                if not auth_state["verification_url"]:
                    auth_state["error"] = f"Authentication failed (exit code {ret}). Check server logs."
                    log(f"Full output: {output}")
                else:
                    log("Device flow ended but URL still available for retry")
                
        except subprocess.TimeoutExpired:
            auth_state["active"] = False
            proc.kill()
            # Keep the URL available even on timeout
            if not auth_state["verification_url"]:
                auth_state["error"] = "Authentication timed out after 5 minutes"
            log("Timeout - killed process")
        except FileNotFoundError as e:
            auth_state["error"] = f"kiro-cli not found: {e}"
            auth_state["active"] = False
            log(f"FileNotFoundError: {e}")
        except Exception as e:
            auth_state["error"] = f"Error: {str(e)}"
            auth_state["active"] = False
            log(f"Exception: {e}")
    
    thread = threading.Thread(target=run_login, daemon=True)
    thread.start()

def get_html():
    """Generate the landing page."""
    authenticated = has_credentials()
    backend_ready = is_backend_running()
    
    # Debug state
    log(f"get_html: auth={authenticated}, backend={backend_ready}, active={auth_state['active']}, url={bool(auth_state['verification_url'])}, code={auth_state.get('user_code')}")
    
    # Auto-start device flow if not authenticated and not already running
    if not authenticated and not auth_state["active"]:
        start_device_flow()
    
    # Auto-start backend if authenticated
    if authenticated and not backend_ready:
        start_backend()
        backend_ready = is_backend_running()
    
    # Determine if we should auto-refresh
    # Refresh when: preparing auth, waiting for user to complete login, or starting backend
    # Don't refresh when: showing error or already ready
    should_refresh = False
    if authenticated and not backend_ready:
        should_refresh = True  # Backend starting
    elif not authenticated and auth_state["active"]:
        should_refresh = True  # Device flow active - poll for completion (even with URL showing)
    
    if authenticated and backend_ready:
        status_color = "#2ecc71"
        status_text = "Ready"
        content = f'''
        <div class="success-box">
            <div class="check-icon">✓</div>
            <h2>Gateway Ready!</h2>
            <p>You are authenticated and the gateway is running.</p>
        </div>
        
        <div class="info-box">
            <h3>API Configuration</h3>
            <p>Set this environment variable to use the gateway:</p>
            <div class="code-block">
                <code>export PROXY_API_KEY={API_KEY}</code>
                <button onclick="copyCode()" class="copy-btn">Copy</button>
            </div>
        </div>
        
        <div class="info-box">
            <h3>API Endpoints</h3>
            <div class="endpoint"><span class="method">POST</span> /v1/chat/completions</div>
            <div class="endpoint"><span class="method">GET</span> /v1/models</div>
        </div>
        '''
    elif authenticated:
        status_color = "#f1c40f"
        status_text = "Starting..."
        content = '''
        <div class="loading-box">
            <div class="spinner"></div>
            <p>Starting the gateway service...</p>
        </div>
        '''
    else:
        status_color = "#e74c3c"
        status_text = "Not Authenticated"
        
        if auth_state["verification_url"]:
            # Show login button
            code_html = ""
            if auth_state["user_code"]:
                code_html = f'<p class="user-code">Enter code: <strong>{auth_state["user_code"]}</strong></p>'
            
            content = f'''
            <div class="login-box">
                <h2>Sign in to Kiro</h2>
                <p>Click the button below to authenticate with your AWS account:</p>
                {code_html}
                <a href="{auth_state["verification_url"]}" target="_blank" class="login-btn">
                    Sign in with AWS
                </a>
                <p class="hint">A new tab will open. Complete the sign-in there.</p>
            </div>
            '''
        elif auth_state["active"]:
            content = '''
            <div class="loading-box">
                <div class="spinner"></div>
                <p>Preparing authentication...</p>
            </div>
            '''
        elif auth_state["error"]:
            content = f'''
            <div class="error-box">
                <h2>Authentication Issue</h2>
                <p>{auth_state["error"]}</p>
                <a href="/" class="retry-btn">Try Again</a>
            </div>
            '''
        else:
            content = '''
            <div class="loading-box">
                <div class="spinner"></div>
                <p>Initializing...</p>
            </div>
            '''
    
    return f'''<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Kiro Gateway</title>
    <style>
        * {{ margin: 0; padding: 0; box-sizing: border-box; }}
        body {{
            font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
            background: linear-gradient(135deg, #1a1a2e 0%, #16213e 100%);
            color: #eee;
            min-height: 100vh;
            display: flex;
            align-items: center;
            justify-content: center;
            padding: 20px;
        }}
        .container {{
            background: rgba(255,255,255,0.05);
            border-radius: 20px;
            padding: 40px;
            max-width: 500px;
            width: 100%;
            box-shadow: 0 8px 32px rgba(0,0,0,0.3);
        }}
        h1 {{
            font-size: 2rem;
            margin-bottom: 8px;
            background: linear-gradient(90deg, #00d4ff, #7b2ff7);
            -webkit-background-clip: text;
            -webkit-text-fill-color: transparent;
        }}
        .subtitle {{ color: #888; margin-bottom: 24px; }}
        .status {{
            display: inline-flex;
            align-items: center;
            gap: 8px;
            padding: 8px 16px;
            border-radius: 20px;
            font-size: 0.9rem;
            margin-bottom: 30px;
            background: rgba(0,0,0,0.3);
        }}
        .status-dot {{
            width: 10px;
            height: 10px;
            border-radius: 50%;
            background: {status_color};
        }}
        .login-box, .success-box, .loading-box, .error-box, .info-box {{
            background: rgba(0,0,0,0.2);
            border-radius: 12px;
            padding: 24px;
            text-align: center;
            margin-bottom: 20px;
        }}
        .success-box {{ border: 1px solid rgba(46, 204, 113, 0.3); }}
        .error-box {{ border: 1px solid rgba(231, 76, 60, 0.3); }}
        .login-box {{ border: 1px solid rgba(123, 47, 247, 0.3); }}
        .info-box {{ text-align: left; }}
        .info-box h3 {{ font-size: 0.9rem; color: #888; margin-bottom: 12px; }}
        .check-icon {{
            width: 60px;
            height: 60px;
            background: rgba(46, 204, 113, 0.2);
            border-radius: 50%;
            display: flex;
            align-items: center;
            justify-content: center;
            font-size: 32px;
            color: #2ecc71;
            margin: 0 auto 16px;
        }}
        h2 {{ margin-bottom: 12px; font-size: 1.3rem; }}
        p {{ color: #aaa; line-height: 1.6; }}
        .user-code {{
            background: rgba(0,0,0,0.3);
            padding: 12px;
            border-radius: 8px;
            margin: 16px 0;
        }}
        .user-code strong {{
            color: #00d4ff;
            font-family: monospace;
            font-size: 1.2rem;
            letter-spacing: 2px;
        }}
        .login-btn, .retry-btn {{
            display: inline-block;
            padding: 14px 40px;
            border-radius: 8px;
            text-decoration: none;
            font-weight: 600;
            margin: 16px 0;
            transition: transform 0.2s, box-shadow 0.2s;
        }}
        .login-btn {{
            background: linear-gradient(90deg, #7b2ff7, #00d4ff);
            color: white;
            font-size: 1rem;
        }}
        .retry-btn {{
            background: rgba(255,255,255,0.1);
            color: #aaa;
            border: 1px solid rgba(255,255,255,0.2);
        }}
        .login-btn:hover, .retry-btn:hover {{
            transform: translateY(-2px);
            box-shadow: 0 4px 20px rgba(123, 47, 247, 0.4);
        }}
        .hint {{ font-size: 0.85rem; color: #666; margin-top: 8px; }}
        .code-block {{
            display: flex;
            align-items: center;
            gap: 12px;
            background: rgba(0,0,0,0.4);
            padding: 12px 16px;
            border-radius: 8px;
            margin-top: 8px;
        }}
        .code-block code {{
            flex: 1;
            font-family: 'Monaco', 'Menlo', monospace;
            font-size: 0.85rem;
            color: #00d4ff;
            word-break: break-all;
        }}
        .copy-btn {{
            background: rgba(255,255,255,0.1);
            border: none;
            color: #aaa;
            padding: 6px 12px;
            border-radius: 4px;
            cursor: pointer;
            font-size: 0.8rem;
        }}
        .copy-btn:hover {{ background: rgba(255,255,255,0.2); }}
        .endpoint {{
            font-family: monospace;
            font-size: 0.85rem;
            color: #aaa;
            padding: 8px 0;
            border-bottom: 1px solid rgba(255,255,255,0.05);
        }}
        .endpoint:last-child {{ border-bottom: none; }}
        .method {{
            display: inline-block;
            background: rgba(0, 212, 255, 0.2);
            color: #00d4ff;
            padding: 2px 8px;
            border-radius: 4px;
            font-size: 0.75rem;
            margin-right: 8px;
        }}
        .spinner {{
            width: 40px;
            height: 40px;
            border: 3px solid rgba(255,255,255,0.1);
            border-top-color: #7b2ff7;
            border-radius: 50%;
            animation: spin 1s linear infinite;
            margin: 0 auto 16px;
        }}
        @keyframes spin {{ to {{ transform: rotate(360deg); }} }}
    </style>
    <script>
        function copyCode() {{
            navigator.clipboard.writeText('export PROXY_API_KEY={API_KEY}');
            document.querySelector('.copy-btn').textContent = 'Copied!';
            setTimeout(() => document.querySelector('.copy-btn').textContent = 'Copy', 2000);
        }}
        {"setTimeout(() => location.reload(), 5000);" if should_refresh else ""}
    </script>
</head>
<body>
    <div class="container">
        <h1>Kiro Gateway</h1>
        <p class="subtitle">Claude models via AWS</p>
        <div class="status">
            <div class="status-dot"></div>
            {status_text}
        </div>
        {content}
    </div>
</body>
</html>'''

class GatewayHandler(BaseHTTPRequestHandler):
    def log_message(self, format, *args):
        print(f"[HTTP] {args[0]}")
    
    def proxy_to_backend(self):
        try:
            conn = http.client.HTTPConnection("127.0.0.1", BACKEND_PORT, timeout=120)
            content_length = int(self.headers.get('Content-Length', 0))
            body = self.rfile.read(content_length) if content_length > 0 else None
            headers = {k: v for k, v in self.headers.items() if k.lower() != 'host'}
            conn.request(self.command, self.path, body=body, headers=headers)
            response = conn.getresponse()
            
            self.send_response(response.status)
            for header, value in response.getheaders():
                if header.lower() not in ('transfer-encoding', 'connection'):
                    self.send_header(header, value)
            self.end_headers()
            
            while True:
                chunk = response.read(8192)
                if not chunk:
                    break
                self.wfile.write(chunk)
            conn.close()
        except Exception as e:
            self.send_error(502, str(e))
    
    def check_api_key(self):
        auth = self.headers.get("Authorization", "")
        if auth.startswith("Bearer "):
            return auth[7:] == API_KEY
        return self.headers.get("X-API-Key") == API_KEY
    
    def handle_request(self):
        path = urlparse(self.path).path
        
        # API requests (have auth header)
        if self.headers.get("Authorization") or self.headers.get("X-API-Key"):
            if not self.check_api_key():
                self.send_response(401)
                self.send_header("Content-Type", "application/json")
                self.end_headers()
                self.wfile.write(json.dumps({"error": {"message": "Invalid API key", "type": "authentication_error"}}).encode())
                return
            
            if not has_credentials():
                self.send_response(503)
                self.send_header("Content-Type", "application/json")
                self.end_headers()
                self.wfile.write(json.dumps({"error": {"message": "Gateway not authenticated. Visit https://kiro.axiologic.dev to sign in.", "type": "service_unavailable"}}).encode())
                return
            
            if not is_backend_running():
                start_backend()
            
            if is_backend_running():
                self.proxy_to_backend()
            else:
                self.send_response(503)
                self.send_header("Content-Type", "application/json")
                self.end_headers()
                self.wfile.write(json.dumps({"error": {"message": "Backend starting, retry in a moment.", "type": "service_unavailable"}}).encode())
            return
        
        # Browser request - serve landing page
        self.send_response(200)
        self.send_header("Content-Type", "text/html")
        self.end_headers()
        self.wfile.write(get_html().encode())
    
    def do_GET(self):
        self.handle_request()
    
    def do_POST(self):
        self.handle_request()
    
    def do_OPTIONS(self):
        self.send_response(200)
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Authorization, Content-Type, X-API-Key")
        self.end_headers()

def run_server():
    log("Checking for existing credentials...")
    if has_credentials():
        log("Credentials found, starting backend...")
        start_backend()
    else:
        log("No credentials found, will start device flow on first request")
    
    server = HTTPServer(("0.0.0.0", PORT), GatewayHandler)
    log(f"Kiro Gateway running on http://0.0.0.0:{PORT}")
    
    def shutdown(sig, frame):
        global backend_process
        if backend_process:
            backend_process.terminate()
        sys.exit(0)
    
    signal.signal(signal.SIGTERM, shutdown)
    signal.signal(signal.SIGINT, shutdown)
    server.serve_forever()

if __name__ == "__main__":
    run_server()
