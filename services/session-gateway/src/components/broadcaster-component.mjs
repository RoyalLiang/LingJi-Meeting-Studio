export class BroadcasterComponent {
  #subscribersBySession = new Map();

  ensureSubscribers(sessionId) {
    let subscribers = this.#subscribersBySession.get(sessionId);
    if (!subscribers) {
      subscribers = new Set();
      this.#subscribersBySession.set(sessionId, subscribers);
    }
    return subscribers;
  }

  openEventStream(sessionId, response, setCorsHeaders) {
    if (setCorsHeaders) {
      setCorsHeaders(response);
    }
    response.writeHead(200, {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive"
    });
    response.write(": connected\n\n");

    const subscribers = this.ensureSubscribers(sessionId);
    subscribers.add(response);

    const keepAliveTimer = setInterval(() => {
      response.write(": keep-alive\n\n");
    }, 15000);

    response.on("close", () => {
      clearInterval(keepAliveTimer);
      subscribers.delete(response);
      if (subscribers.size === 0) {
        this.#subscribersBySession.delete(sessionId);
      }
    });
  }

  broadcast(sessionId, event) {
    const subscribers = this.#subscribersBySession.get(sessionId);
    if (!subscribers) {
      return;
    }

    const payload = `data: ${JSON.stringify(event)}\n\n`;
    for (const subscriber of subscribers) {
      try {
        subscriber.write(payload);
      } catch (err) {
        // ignore write error on closed client
      }
    }
  }

  deleteSession(sessionId) {
    const subscribers = this.#subscribersBySession.get(sessionId);
    if (subscribers) {
      this.#subscribersBySession.delete(sessionId);
    }
  }
}
