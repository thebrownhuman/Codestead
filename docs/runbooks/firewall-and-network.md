# Firewall and network runbook

## Invariants

- The NUC publishes no Docker host ports. In particular, 3000, 5432, and 4100 are not public.
- Public web traffic reaches `cloudflared` through outbound Tunnel connections only.
- SSH is accepted only through a private admin subnet or VPN.
- Runner port 4100 exists only on the runner VM's private interface and accepts only the trusted NUC source address.
- Job containers use `--network none`; do not weaken this for package installation or exercises.

Ubuntu's supported host firewall frontend is `ufw`; see Canonical's [Firewall guide](https://documentation.ubuntu.com/server/how-to/security/firewalls/). Apply rules from an existing console or a tested second SSH session so a mistake does not lock out the operator.

## Trusted NUC

Replace the example admin subnet before running anything:

```bash
sudo ufw default deny incoming
sudo ufw default allow outgoing
sudo ufw allow from 10.20.10.0/24 to any port 22 proto tcp comment 'private admin SSH'
sudo ufw enable
sudo ufw status verbose
```

Do not add inbound rules for HTTP, HTTPS, PostgreSQL, Next.js, or the runner. If outbound policy is later changed to deny, preserve DNS, NTP, Ubuntu/Docker update endpoints, Google OAuth or configured model-provider APIs, and Cloudflare Tunnel egress. Cloudflare currently documents tunnel egress on TCP/UDP 7844; use its maintained destination list rather than freezing copied addresses.

Verify from an unrelated internet connection:

```bash
nmap -Pn -p 22,80,443,3000,4100,5432 PUBLIC_IP
```

All listed ports should be closed or filtered. The application hostname should still work through Cloudflare.

## Runner VM

The authoritative topology is the libvirt `default` network on bridge `virbr0`, with host `192.168.122.1` and the reviewed `codestead-runner` reservation at `192.168.122.12`. Do not create a custom runner network or substitute an older address.

Runner API ingress is enforced by the reviewed nftables files, not by an example UFW rule. On the trusted NUC, `learncoding-runner-firewall.service` allows only fixed Compose gateway source `172.29.40.2` on `cdst-run0` to guest TCP 4100 and rejects every other runner-egress path. Inside the guest, `learncoding-runner-guest-firewall.service` default-denies ingress, allows host `192.168.122.1` to SSH and TCP 4100, and allows only gateway source `172.29.40.2` to TCP 4100. Unrelated host traffic remains outside the dedicated Codestead table.

Verify the installed policies without replacing them:

```bash
# On the trusted NUC
sudo systemctl is-enabled learncoding-runner-firewall.service
sudo systemctl is-active learncoding-runner-firewall.service
sudo nft list table inet codestead_runner

# Inside the dedicated runner VM
sudo systemctl is-enabled learncoding-runner-guest-firewall.service
sudo systemctl is-active learncoding-runner-guest-firewall.service
sudo nft list table inet codestead_runner_guest
sudo ss -lnt '( sport = :4100 )'
```

Set `RUNNER_HOST=192.168.122.12`, never `0.0.0.0`. Administrative SSH reaches the guest through the trusted host path; do not open port 22 to an arbitrary LAN. After pre-pulling all digest-pinned runtime images, consider restricting VM egress at the hypervisor firewall. Re-open only the minimum apt and registry egress during a supervised patch/image-refresh window. The runner API itself does not need internet access.

Confirm the runner implementation still emits Docker flags for `--pull never`, `--network none`, read-only root, dropped capabilities, no-new-privileges, PID/memory/CPU/file limits, and an unprivileged UID before each release.

## Docker and UFW caution

Docker can manage netfilter rules outside ordinary UFW input paths. This deployment avoids that ambiguity by having no `ports:` declarations in the trusted Compose model. After every Compose change, run the static validator and inspect the rendered config:

```bash
node infra/tests/validate-static.mjs
sudo docker compose --env-file /etc/learncoding/compose.env -f /opt/learncoding/compose.yaml config | grep -n 'ports:'
```

The second command must return no matches. Also inspect `docker ps --format '{{.Names}} {{.Ports}}'`; no Codestead container should show a host binding.

## Boundary test after change

1. Public hostname works through Cloudflare.
2. Direct public-IP probes show no service port.
3. A NUC request to the private runner health endpoint succeeds with the expected authentication behavior.
4. A different LAN host cannot connect to runner port 4100.
5. A submitted program cannot resolve DNS or open an outbound socket.
6. PostgreSQL is reachable only from the internal Compose network.
