# MRPscan backend

API reference: [REST_APIS.md](REST_APIS.md). Services: [SERVICES.md](SERVICES.md).

## Pricing engine (Python worker)

The MRP's arithmetic (`src/services/pricingMath.js`: pure weight, gold, wastage,
labour, stones, subtotal) runs in a long-lived Python worker,
`calc/calc_worker.py` (numpy and pandas), when `CALC_ENGINE=python`, the
default. Node still gathers the rates and settings, sends the numbers to the
worker over stdin/stdout and gets the same figures back to the last bit
(`tests/pricingParity.test.js`). If Python is missing, still starting,
slower than 1.5 s, crashes or answers wrongly, that price is worked out in Node
instead, so pricing never fails because of Python. Each kind of failure is
logged once (`[CALC_ENGINE] ...`).

One worker serves all prices in turn, so none may tie it up: a price with more
than 500 stone rows or a request over 128 KB is worked out in Node and never
sent (`oversized`), and while 256 requests are already waiting on the worker
further ones go to Node at once (`busy`). A worker that is behind but still
answering is kept; it is restarted only after a whole timeout with no answer.

### EC2 setup (Amazon Linux)

```sh
sudo dnf install -y python3 python3-pip        # sudo yum install ... on older images
cd backend
python3 -m pip install --user -r calc/requirements.txt
pm2 restart all                                 # or the backend's own pm2 name
```

Install as the same user pm2 runs the backend as (`--user` installs per user).
The worker takes about 70 MB of memory per backend process.

### Which engine is running

At startup the log says, for example:

```
[CALC_ENGINE] engine=python python=python3 timeout=1500ms shadow=off
[CALC_WORKER] calc_worker ready pid=12345 python=3.9.x numpy=2.0.2 pandas=2.3.3
[CALC_ENGINE] python worker ready (pid 12345, 1400 ms)
```

`pm2 logs | grep CALC_` shows it. `python worker not ready` or `was not
found` means prices are being worked out in Node; check the install above.
Until the packages are installed the worker is retried (every minute at
most); its error is logged on the first attempt only, and once installed it
comes back by itself.

### Settings (.env)

| Variable | Default | Meaning |
| --- | --- | --- |
| `CALC_ENGINE` | `python` | `js` turns the worker off: everything in Node, Python never started |
| `CALC_ENGINE_SHADOW` | `false` | `true` runs both on every price and logs `[CALC_SHADOW]` on any difference (Node's figures are then used) |
| `PYTHON_BIN` | `python3` (`python` on Windows) | the interpreter to run the worker with |

To turn it off: `CALC_ENGINE=js` in `.env`, then `pm2 restart`.

`node scripts/calc_engine_latency.js` measures both engines on the machine it
runs on (no network, no paid calls).
