# Element CE — follow-ups

- [ ] **Voice and video calls need a TURN relay, and there is none.**

      Element's calls are WebRTC. Two browsers try to connect directly, and
      when both sit behind NAT or a restrictive firewall that fails, so the
      media has to be relayed. Without a relay, calls work between some
      participants and silently fail between others — the "works at the
      office, not from home" symptom, which reads as a broken app rather than
      as missing infrastructure.

      The kernel used to carry `kernelServices.turn*` — six values, six
      ConfigMap keys and a `${TURN_*}` substitution into `extraValues`. No
      server was ever shipped behind them, no profile ever consumed them, and
      `turnHost` was empty on every cluster. They were removed (gentian-os
      P9: an app declares needs, never endpoints), and `${TURN_CREDENTIALS}`
      went with them — it substituted a shared secret into a ConfigMap, so
      into etcd and the Admin Console.

      Ship coturn as a companion to this profile (ladder L2), not as kernel
      infrastructure: Element is the only WebRTC consumer in the catalogue, so
      a standalone profile providing a `turn` contract is ceremony until a
      second one exists. If Jitsi or Nextcloud Talk arrive, promote it then —
      `provides: turn` plus `optionalIntegrations`, with the secret at
      `gentian-os/tenants/<t>/contracts/turn`, which is the path that keeps it
      out of a ConfigMap.

      Three things to settle before writing it:

      - **Synapse wants the shared secret, not a credential pair.** It mints
        per-user, time-limited credentials itself from `turn_shared_secret`.
        So the wiring is `turn_uris` plus that secret, delivered as a
        secretKeyRef — not the `{host, port, user, password}` shape the other
        kernel requirements use.
      - **A relay needs a large public UDP port range** (commonly
        49152–65535) on a reachable address. Two relays cannot both own it on
        one cluster, so a per-tenant companion needs its own external IP or a
        carved, non-overlapping range. Decide which before the second tenant
        installs Element.
      - **UDP rules out `networkMode: tunnel`.** A Cloudflare HTTP tunnel does
        not carry it. Same class of limitation as kernel mail and port 25, and
        it should fail with a message that says so rather than producing calls
        that never connect.
