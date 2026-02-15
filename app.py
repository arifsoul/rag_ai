import uvicorn
import webbrowser
import threading
import time
import os
import socket


def wait_for_server(host, port, timeout=30):
    """Wait for the server to be available."""
    start_time = time.time()
    while time.time() - start_time < timeout:
        try:
            with socket.create_connection((host, port), timeout=1):
                return True
        except (OSError, ConnectionRefusedError):
            time.sleep(0.5)
    return False


def open_browser(host, port):
    """Opens the browser after server is ready."""
    if wait_for_server(host, port):
        print(f"Server ready at http://{host}:{port}. Opening browser...")
        webbrowser.open(f"http://{host}:{port}")
    else:
        print("Server check timed out. Browser not opened automatically.")


if __name__ == "__main__":
    # Ensure directories exist
    os.makedirs("databases", exist_ok=True)

    HOST = "0.0.0.0"
    PORT = 8000

    # Start browser in a separate thread
    # Use localhost for browser, but bind to 0.0.0.0
    threading.Thread(target=open_browser, args=("localhost", PORT), daemon=True).start()

    # Run the server
    uvicorn.run("backend.main:app", host=HOST, port=PORT, reload=True)
