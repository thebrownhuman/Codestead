#!/usr/bin/env bash
set -Eeuo pipefail
umask 077
python_bin="$(command -v python3 || command -v python || true)"
PATH=/usr/bin:/bin
export PATH
PYTHONDONTWRITEBYTECODE=1
export PYTHONDONTWRITEBYTECODE

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd -P)"
provisioner="$repo_root/infra/runner-vm/provision-host.sh"
helper="$repo_root/infra/runner-vm/codestead_runner_provision.py"
contract="$repo_root/infra/runner-vm/runner-contract.json"
network="$repo_root/infra/runner-vm/codestead-runner-network.xml"
meta="$repo_root/infra/runner-vm/cloud-init/meta-data"
user_data="$repo_root/infra/runner-vm/cloud-init/user-data.template"

fail() {
  printf 'FAIL: %s\n' "$*" >&2
  exit 1
}

missing=()
for required in "$provisioner" "$helper" "$contract" "$network" "$meta" "$user_data"; do
  [[ -f "$required" ]] || missing+=("${required#"$repo_root/"}")
done
if (( ${#missing[@]} > 0 )); then
  printf '%s\n' 'runner VM trusted-provisioning contract failed:' >&2
  for required in "${missing[@]}"; do printf -- '- missing required asset: %s\n' "$required" >&2; done
  exit 1
fi

[[ -n "$python_bin" ]] || fail 'Python 3 is required for portable semantic contract tests'
"$python_bin" -c 'import sys; assert sys.version_info >= (3, 11)' || fail 'Python 3.11+ is required'

[[ "$(head -n 1 "$provisioner")" == '#!/usr/bin/bash -p' ]] ||
  fail 'production bootstrap must use fixed privileged-mode /usr/bin/bash'
grep -Fq 'export LC_ALL=C' "$provisioner" || fail 'production bootstrap must fix LC_ALL=C'
grep -Fq '/usr/bin/env -i' "$provisioner" || fail 'production bootstrap must clear the ambient environment'
grep -Fq '/usr/bin/timeout' "$provisioner" || fail 'production bootstrap must enforce a total deadline'
grep -Fq '/usr/bin/python3 -I -B' "$provisioner" || fail 'production bootstrap must isolate the stdlib helper'
grep -Fq 'trusted_bootstrap=' "$provisioner" || fail 'production bootstrap must verify helper bytes before execution'
grep -Fq 'O_NOFOLLOW' "$provisioner" || fail 'production bootstrap must open the helper without following links'
grep -Fq 'os.fstat' "$provisioner" || fail 'production bootstrap must bind verification to one open descriptor'
grep -Fq 'hashlib.sha256' "$provisioner" || fail 'production bootstrap must hash verified helper bytes'
grep -Fq 'compile(source, path, "exec")' "$provisioner" || fail 'production bootstrap must compile the verified descriptor bytes'
grep -Fq 'exec(code, namespace, namespace)' "$provisioner" || fail 'production bootstrap must execute only verified helper bytes'
grep -Fq -- '-c "$trusted_bootstrap" "$helper" "$helper_sha256"' "$provisioner" ||
  fail 'production bootstrap must pass the pinned digest to the pre-execution verifier'
if grep -Fq '/usr/bin/python3 -I -B "$helper"' "$provisioner"; then
  fail 'production bootstrap still executes the helper path before verification'
fi
if grep -Eq '(^|[;&|()[:space:]])(env|timeout|python3|virsh|qemu-img|cloud-localds|virt-install|ssh-keygen|systemctl)([;&|()[:space:]]|$)' "$provisioner"; then
  fail 'production bootstrap contains an ambient executable lookup'
fi
grep -Eq "^helper_sha256='[0-9a-f]{64}'$" "$provisioner" ||
  fail 'production bootstrap must pin the semantic helper digest'
grep -Eq "^contract_sha256='[0-9a-f]{64}'$" "$provisioner" ||
  fail 'production bootstrap must pin the reviewed contract-manifest digest'

actual_helper_sha="$($python_bin -c 'import hashlib,sys; print(hashlib.sha256(open(sys.argv[1],"rb").read()).hexdigest())' "$helper")"
actual_contract_sha="$($python_bin -c 'import hashlib,sys; print(hashlib.sha256(open(sys.argv[1],"rb").read()).hexdigest())' "$contract")"
pinned_helper_sha="$(sed -n "s/^helper_sha256='\([0-9a-f]\{64\}\)'$/\1/p" "$provisioner")"
pinned_contract_sha="$(sed -n "s/^contract_sha256='\([0-9a-f]\{64\}\)'$/\1/p" "$provisioner")"
[[ "$actual_helper_sha" == "$pinned_helper_sha" ]] || fail 'production bootstrap helper digest is stale'
[[ "$actual_contract_sha" == "$pinned_contract_sha" ]] || fail 'production bootstrap contract digest is stale'

actual_network_sha="$($python_bin -c 'import hashlib,sys; print(hashlib.sha256(open(sys.argv[1],"rb").read()).hexdigest())' "$network")"
actual_meta_sha="$($python_bin -c 'import hashlib,sys; print(hashlib.sha256(open(sys.argv[1],"rb").read()).hexdigest())' "$meta")"
actual_user_sha="$($python_bin -c 'import hashlib,sys; print(hashlib.sha256(open(sys.argv[1],"rb").read()).hexdigest())' "$user_data")"
"$python_bin" - "$contract" "$actual_network_sha" "$actual_meta_sha" "$actual_user_sha" "$provisioner" <<'PY'
import json
import re
import sys
import tempfile

path, network_sha, meta_sha, user_sha, provisioner_path = sys.argv[1:]

def _unique(pairs):
    result = {}
    for key, value in pairs:
        if key in result:
            raise ValueError(f"duplicate key: {key}")
        result[key] = value
    return result

with open(path, "r", encoding="utf-8") as handle:
    contract = json.load(handle, object_pairs_hook=lambda pairs: _unique(pairs))

expected = {
    "network_sha256": network_sha,
    "meta_data_sha256": meta_sha,
    "user_data_template_sha256": user_sha,
}
for key, value in expected.items():
    assert contract[key] == value, (key, contract.get(key), value)
assert contract["version"] == 1
assert contract["domain"] == {
    "name": "codestead-runner",
    "osinfo": "ubuntu24.04",
    "vcpus": 4,
    "memory_mib": 8192,
    "disk_bytes": 107374182400,
    "mac": "52:54:00:20:00:12",
    "network": "default",
    "disk_path": "/var/lib/libvirt/images/codestead-runner.qcow2",
    "seed_path": "/var/lib/libvirt/boot/codestead-runner-seed.iso",
}
assert contract["network"] == {
    "name": "default",
    "bridge": "virbr0",
    "host_ip": "192.168.122.1",
    "netmask": "255.255.255.0",
    "dhcp_start": "192.168.122.2",
    "dhcp_end": "192.168.122.254",
    "guest_ip": "192.168.122.12",
    "mac": "52:54:00:20:00:12",
}
deadlines = contract["deadlines"]
assert deadlines["total_seconds"] <= 900
assert deadlines["kill_after_seconds"] == 5
assert deadlines["outer_kill_after_seconds"] >= 15
assert deadlines["outer_kill_after_seconds"] >= deadlines["kill_after_seconds"] * 2 + 5
with open(provisioner_path, "r", encoding="utf-8") as handle:
    provisioner_source = handle.read()
timeout_match = re.search(
    r"exec /usr/bin/timeout --signal=TERM --kill-after=([0-9]+)s ([0-9]+)s",
    provisioner_source,
)
assert timeout_match is not None
assert int(timeout_match.group(1)) == deadlines["outer_kill_after_seconds"]
assert int(timeout_match.group(2)) == deadlines["total_seconds"]
PY

if grep -Eq 'virbr-cdst|10\.20\.0\.|"network"[[:space:]]*:[[:space:]]*"codestead-runner"' \
  "$helper" "$contract" "$network"; then
  fail 'runner VM assets still encode the superseded dedicated-network topology'
fi

"$python_bin" - "$helper" <<'PY'
from __future__ import annotations

import contextlib
import importlib.util
import inspect
import json
import sys
import tempfile
import unittest
from unittest import mock
from pathlib import Path

helper_path = Path(sys.argv[1])
spec = importlib.util.spec_from_file_location("codestead_runner_provision", helper_path)
assert spec is not None and spec.loader is not None
module = importlib.util.module_from_spec(spec)
sys.modules[spec.name] = module
spec.loader.exec_module(module)

ContractError = module.ContractError


def portable_fake_fchmod():
    """Supply only a fake-test capability absent from Windows Python 3.11."""

    if hasattr(module.os, "fchmod"):
        return contextlib.nullcontext()
    return mock.patch.object(
        module.os,
        "fchmod",
        lambda _descriptor, _mode: None,
        create=True,
    )

NETWORK = """<network>
  <name>default</name>
  <forward mode='nat'/>
  <bridge name='virbr0' stp='on' delay='0'/>
  <ip address='192.168.122.1' netmask='255.255.255.0'>
    <dhcp>
      <range start='192.168.122.2' end='192.168.122.254'/>
      <host mac='52:54:00:20:00:12' name='codestead-runner' ip='192.168.122.12'/>
    </dhcp>
  </ip>
</network>"""

INACTIVE_NETWORK = NETWORK.replace(
    "<name>default</name>",
    "<name>default</name><uuid>11111111-2222-4333-8444-555555555555</uuid>",
)

EXISTING_DEFAULT_WITHOUT_RUNNER = INACTIVE_NETWORK.replace(
    "      <host mac='52:54:00:20:00:12' name='codestead-runner' ip='192.168.122.12'/>\n",
    "      <host mac='52:54:00:aa:bb:cc' name='unrelated-vm' ip='192.168.122.50'/>\n",
)

EXISTING_DEFAULT_WITH_UNRELATED = INACTIVE_NETWORK.replace(
    "      <host mac='52:54:00:20:00:12' name='codestead-runner' ip='192.168.122.12'/>\n",
    "      <host mac='52:54:00:aa:bb:cc' name='unrelated-vm' ip='192.168.122.50'/>\n"
    "      <host mac='52:54:00:20:00:12' name='codestead-runner' ip='192.168.122.12'/>\n",
)

# Representative Ubuntu Noble virtinst 4.1.0 output for the exact production
# argv below. This is the generation boundary before libvirt canonicalization.
NOBLE_VIRT_INSTALL_4_1_0_DOMAIN = """<domain type="kvm">
  <name>codestead-runner</name>
  <uuid>aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee</uuid>
  <metadata>
    <libosinfo:libosinfo xmlns:libosinfo="http://libosinfo.org/xmlns/libvirt/domain/1.0">
      <libosinfo:os id="http://ubuntu.com/ubuntu/24.04"/>
    </libosinfo:libosinfo>
  </metadata>
  <memory>8388608</memory>
  <currentMemory>8388608</currentMemory>
  <vcpu>4</vcpu>
  <os><type arch="x86_64" machine="q35">hvm</type><boot dev="hd"/></os>
  <features><acpi/><apic/></features>
  <cpu mode="host-passthrough"/>
  <clock offset="utc"><timer name="rtc" tickpolicy="catchup"/><timer name="pit" tickpolicy="delay"/><timer name="hpet" present="no"/></clock>
  <pm><suspend-to-mem enabled="no"/><suspend-to-disk enabled="no"/></pm>
  <devices>
    <emulator>/usr/bin/qemu-system-x86_64</emulator>
    <disk type="file" device="disk"><driver name="qemu" type="qcow2" cache="none"/><source file="/var/lib/libvirt/images/codestead-runner.qcow2"/><target dev="vda" bus="virtio"/></disk>
    <disk type="file" device="cdrom"><driver name="qemu" type="raw"/><source file="/var/lib/libvirt/boot/codestead-runner-seed.iso"/><target dev="sda" bus="sata"/><readonly/></disk>
    <controller type="usb" model="qemu-xhci" ports="15"/>
    <controller type="pci" model="pcie-root"/>
    <controller type="pci" model="pcie-root-port"/>
    <controller type="pci" model="pcie-root-port"/>
    <controller type="pci" model="pcie-root-port"/>
    <controller type="pci" model="pcie-root-port"/>
    <controller type="pci" model="pcie-root-port"/>
    <controller type="pci" model="pcie-root-port"/>
    <controller type="pci" model="pcie-root-port"/>
    <controller type="pci" model="pcie-root-port"/>
    <controller type="pci" model="pcie-root-port"/>
    <controller type="pci" model="pcie-root-port"/>
    <controller type="pci" model="pcie-root-port"/>
    <controller type="pci" model="pcie-root-port"/>
    <controller type="pci" model="pcie-root-port"/>
    <controller type="pci" model="pcie-root-port"/>
    <interface type="network"><source network="default"/><mac address="52:54:00:20:00:12"/><model type="virtio"/></interface>
    <console type="pty"/>
    <channel type="unix"><source mode="bind"/><target type="virtio" name="org.qemu.guest_agent.0"/></channel>
    <memballoon model="virtio"/>
    <rng model="virtio"><backend model="random">/dev/urandom</backend></rng>
  </devices>
</domain>"""
INACTIVE_DOMAIN = """<domain type='kvm'>
  <name>codestead-runner</name>
  <uuid>aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee</uuid>
  <memory unit='KiB'>8388608</memory>
  <currentMemory unit='KiB'>8388608</currentMemory>
  <vcpu placement='static' current='4'>4</vcpu>
  <cpu mode='host-passthrough' check='none' migratable='on'/>
  <os><type arch='x86_64' machine='pc-q35-8.2'>hvm</type><boot dev='hd'/></os>
  <features><acpi/><apic/></features>
  <clock offset='utc'><timer name='rtc' tickpolicy='catchup'/><timer name='pit' tickpolicy='delay'/><timer name='hpet' present='no'/></clock>
  <on_poweroff>destroy</on_poweroff><on_reboot>restart</on_reboot><on_crash>destroy</on_crash>
  <pm><suspend-to-mem enabled='no'/><suspend-to-disk enabled='no'/></pm>
  <seclabel type='dynamic' model='apparmor' relabel='yes'/>
  <devices>
    <emulator>/usr/bin/qemu-system-x86_64</emulator>
    <disk type='file' device='disk'>
      <driver name='qemu' type='qcow2' cache='none'/>
      <source file='/var/lib/libvirt/images/codestead-runner.qcow2'/>
      <target dev='vda' bus='virtio'/>
    </disk>
    <disk type='file' device='cdrom'>
      <driver name='qemu' type='raw'/>
      <source file='/var/lib/libvirt/boot/codestead-runner-seed.iso'/>
      <target dev='sda' bus='sata'/><readonly/>
    </disk>
    <controller type='pci' index='0' model='pcie-root'/>
    <controller type='sata' index='0'/>
    <interface type='network'>
      <mac address='52:54:00:20:00:12'/>
      <source network='default'/>
      <model type='virtio'/>
    </interface>
    <serial type='pty'><target type='isa-serial' port='0'/></serial>
    <console type='pty'><target type='serial' port='0'/></console>
    <memballoon model='virtio'/>
  </devices>
</domain>"""

LIVE_APPARMOR_SECLABEL = (
    "<seclabel type='dynamic' model='apparmor' relabel='yes'>"
    "<label>libvirt-aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee</label>"
    "<imagelabel>libvirt-aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee</imagelabel>"
    "</seclabel>"
)
LIVE_DAC_SECLABEL = (
    "<seclabel type='dynamic' model='dac' relabel='yes'>"
    "<label>+64055:+108</label>"
    "<imagelabel>+64055:+108</imagelabel>"
    "</seclabel>"
)
LIVE_DOMAIN = INACTIVE_DOMAIN.replace(
    "<seclabel type='dynamic' model='apparmor' relabel='yes'/>",
    LIVE_APPARMOR_SECLABEL + LIVE_DAC_SECLABEL,
).replace(
    "<source network='default'/>",
    "<source network='default' bridge='virbr0' portid='12345678-1234-4234-8234-123456789abc'/>",
).replace(
    "<model type='virtio'/>",
    "<target dev='vnet7'/><model type='virtio'/><alias name='net0'/><address type='pci' domain='0x0000' bus='0x01' slot='0x00' function='0x0'/>",
    1,
)

EXPECTED_VIRT_INSTALL_ARGV = (
    "/usr/bin/virt-install", "--connect", "qemu:///system", "--name", "codestead-runner",
    "--virt-type", "kvm", "--vcpus", "4", "--memory", "8192", "--cpu", "host-passthrough",
    "--osinfo", "ubuntu24.04", "--import",
    "--disk", "path=/var/lib/libvirt/images/codestead-runner.qcow2,bus=virtio,format=qcow2,cache=none",
    "--disk", "path=/var/lib/libvirt/boot/codestead-runner-seed.iso,device=cdrom,bus=sata,readonly=on",
    "--network", "network=default,mac=52:54:00:20:00:12,model=virtio",
    "--graphics", "none", "--noautoconsole", "--print-xml",
)

GOOD_IMAGE = {
    "virtual-size": 107374182400,
    "filename": "/var/lib/libvirt/images/codestead-runner.qcow2",
    "cluster-size": 65536,
    "format": "qcow2",
    "actual-size": 2097152,
    "dirty-flag": False,
    "snapshots": [],
    "format-specific": {"type": "qcow2", "data": {"compat": "1.1", "compression-type": "zlib"}},
}


class FakeDefaultNetworkRunner:
    """No-host-mutation virsh model for the actual convergence function."""

    def __init__(self, inactive_xml, *, active, autostart, live_xml=None):
        self.uuid = "11111111-2222-4333-8444-555555555555"
        self.inactive_xml = inactive_xml
        self.active = active
        self.autostart = autostart
        self.live_xml = live_xml if live_xml is not None else (inactive_xml if active else None)
        self.commands = []
        self.replace_uuid_before_update = False
        self.updates_applied = 0

    def run(self, argv, **_kwargs):
        self.commands.append(tuple(argv))
        action = argv[3]
        output = ""
        if action == "net-list":
            output = "default\n"
        elif action == "net-uuid":
            output = self.uuid + "\n"
        elif action == "net-info":
            output = (
                f"Name: default\nUUID: {self.uuid}\n"
                f"Active: {'yes' if self.active else 'no'}\n"
                "Persistent: yes\n"
                f"Autostart: {'yes' if self.autostart else 'no'}\n"
                "Bridge: virbr0\n"
            )
        elif action == "net-dumpxml":
            output = self.inactive_xml if "--inactive" in argv else self.live_xml
            if output is None:
                raise AssertionError("live XML requested while fake network is inactive")
        elif action == "net-dhcp-leases":
            output = ""
        elif action == "net-update":
            if self.replace_uuid_before_update:
                self.uuid = "99999999-8888-4777-8666-555555555555"
                raise ContractError("captured network UUID no longer exists")
            if argv[4] != self.uuid:
                raise AssertionError("net-update was not bound to the captured UUID")
            if "--config" in argv:
                self.inactive_xml = module.add_default_network_reservation(self.inactive_xml)
            if "--live" in argv:
                assert self.live_xml is not None
                self.live_xml = module.add_default_network_reservation(self.live_xml)
            self.updates_applied += 1
        elif action == "net-autostart":
            if argv[4] != self.uuid:
                raise AssertionError("net-autostart was not UUID-bound")
            self.autostart = True
        elif action == "net-start":
            if argv[4] != self.uuid:
                raise AssertionError("net-start was not UUID-bound")
            self.active = True
            self.live_xml = self.inactive_xml
        else:
            raise AssertionError(f"unexpected fake virsh action: {action}")
        return module.subprocess.CompletedProcess(list(argv), 0, output, "")


class FakeDomainRunner:
    def __init__(self, generated_xml=NOBLE_VIRT_INSTALL_4_1_0_DOMAIN):
        self.uuid = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee"
        self.generated_xml = generated_xml
        self.commands = []
        self.defined = False
        self.autostart = False
        self.running = False

    def run(self, argv, **_kwargs):
        self.commands.append(tuple(argv))
        if argv[0] == "/usr/bin/virt-install":
            if tuple(argv) != EXPECTED_VIRT_INSTALL_ARGV:
                raise AssertionError(f"virt-install argv drift: {tuple(argv)!r}")
            output = self.generated_xml
        else:
            action = argv[3]
            if action == "list":
                output = "codestead-runner\n" if self.defined else ""
            elif action == "define":
                self.defined = True
                output = ""
            elif action == "domuuid":
                output = self.uuid + "\n"
            elif action == "dumpxml":
                output = LIVE_DOMAIN if self.running and "--inactive" not in argv else INACTIVE_DOMAIN
            elif action == "autostart":
                self.autostart = True
                output = ""
            elif action == "start":
                self.running = True
                output = ""
            elif action == "dominfo":
                output = (
                    f"Id: {'7' if self.running else '-'}\nName: codestead-runner\nUUID: {self.uuid}\n"
                    f"State: {'running' if self.running else 'shut off'}\n"
                    "CPU(s): 4\nMax memory: 8388608 KiB\nUsed memory: 8388608 KiB\n"
                    f"Persistent: yes\nAutostart: {'enable' if self.autostart else 'disable'}\n"
                )
            elif action == "domblklist":
                output = (
                    "Type Device Target Source\n"
                    "-----------------------------------------------\n"
                    "file disk vda /var/lib/libvirt/images/codestead-runner.qcow2\n"
                    "file cdrom sda /var/lib/libvirt/boot/codestead-runner-seed.iso\n"
                )
            else:
                raise AssertionError(f"unexpected fake domain action: {action}")
        return module.subprocess.CompletedProcess(list(argv), 0, output, "")


class FakeIntegratedRunner(FakeDefaultNetworkRunner):
    def __init__(self, *, crash_after=None):
        super().__init__(
            EXISTING_DEFAULT_WITHOUT_RUNNER,
            active=False,
            autostart=False,
        )
        self.domain = FakeDomainRunner()
        self.crash_after = crash_after

    def run(self, argv, **kwargs):
        if argv[0] == "/usr/bin/systemctl":
            self.commands.append(tuple(argv))
            return module.subprocess.CompletedProcess(list(argv), 0, "active\n", "")
        domain_action = argv[0] == "/usr/bin/virt-install" or (
            argv[0] == "/usr/bin/virsh"
            and argv[3] in {"list", "define", "domuuid", "dumpxml", "autostart", "start", "dominfo", "domblklist"}
        )
        if domain_action:
            result = self.domain.run(argv, **kwargs)
            self.commands.append(tuple(argv))
            action = "virt-install" if argv[0] == "/usr/bin/virt-install" else argv[3]
            if self.crash_after == action:
                self.crash_after = None
                raise ContractError(f"simulated lifecycle cut after {action}")
            return result
        return super().run(argv, **kwargs)


class SemanticContractTests(unittest.TestCase):
    def assert_rejected(self, function, *args, **kwargs):
        with self.assertRaises(ContractError):
            function(*args, **kwargs)

    def test_osinfo_catalog_requires_exact_pinned_ubuntu_short_id(self):
        module.validate_osinfo_catalog("ubuntu24.04  Ubuntu 24.04 LTS\n")
        for catalog in (
            "ubuntu24.040  lookalike\n",
            "ubuntu24.04-desktop  lookalike\n",
            "fedora40  Fedora 40\n",
            "",
        ):
            with self.subTest(catalog=catalog):
                self.assert_rejected(module.validate_osinfo_catalog, catalog)

    def test_osinfo_preflight_is_covered_by_installed_signal_handlers(self):
        source = inspect.getsource(module._provision)
        handler_install = source.index("signal.signal(handled_signal, stop_for_signal)")
        osinfo_query = source.index('["/usr/bin/virt-install", "--osinfo", "list"]')
        self.assertLess(handler_install, osinfo_query)

    def test_source_and_existing_default_network_preserve_unrelated_hosts(self):
        source = module.validate_network_xml(NETWORK, "source", None)
        self.assertTrue(source["reservation_present"])
        existing = module.validate_network_xml(
            EXISTING_DEFAULT_WITHOUT_RUNNER,
            "inactive",
            "11111111-2222-4333-8444-555555555555",
        )
        self.assertFalse(existing["reservation_present"])
        with_unrelated = module.validate_network_xml(
            EXISTING_DEFAULT_WITH_UNRELATED,
            "inactive",
            "11111111-2222-4333-8444-555555555555",
        )
        self.assertTrue(with_unrelated["reservation_present"])

        updated = module.add_default_network_reservation(EXISTING_DEFAULT_WITHOUT_RUNNER)
        updated_result = module.validate_network_xml(
            updated,
            "inactive",
            "11111111-2222-4333-8444-555555555555",
        )
        self.assertTrue(updated_result["reservation_present"])
        self.assertIn("unrelated-vm", updated)
        self.assertEqual(updated.count("52:54:00:20:00:12"), 1)
        self.assert_rejected(module.add_default_network_reservation, INACTIVE_NETWORK)

    def test_bridge_mac_is_part_of_non_target_network_fingerprint(self):
        first = INACTIVE_NETWORK.replace(
            "<bridge name='virbr0' stp='on' delay='0'/>",
            "<bridge name='virbr0' stp='on' delay='0'/><mac address='52:54:00:11:22:33'/>",
        )
        second = first.replace("52:54:00:11:22:33", "52:54:00:44:55:66")
        first_result = module.validate_network_xml(
            first, "inactive", "11111111-2222-4333-8444-555555555555"
        )
        second_result = module.validate_network_xml(
            second, "inactive", "11111111-2222-4333-8444-555555555555"
        )
        self.assertNotEqual(first_result["bridge_mac"], second_result["bridge_mac"])
        self.assertNotEqual(
            first_result["non_target_sha256"], second_result["non_target_sha256"]
        )

    def test_network_rejects_every_valid_extra(self):
        mutations = [
            NETWORK.replace("</network>", "<ip address='172.31.0.1' netmask='255.255.255.0'/></network>"),
            NETWORK.replace("</network>", "<route address='10.0.0.0' prefix='8' gateway='192.168.122.2'/></network>"),
            NETWORK.replace("</network>", "<dns><host ip='192.168.122.12'><hostname>runner</hostname></host></dns></network>"),
            NETWORK.replace("<forward mode='nat'/>", "<forward mode='nat'/><forward mode='route'/>")
        ]
        for mutation in mutations:
            with self.subTest(mutation=mutation[-100:]):
                self.assert_rejected(module.validate_network_xml, mutation, "source", None)

    def test_existing_default_rejects_reservation_conflicts_and_duplicate_identity(self):
        conflicts = [
            EXISTING_DEFAULT_WITHOUT_RUNNER.replace(
                "ip='192.168.122.50'", "ip='192.168.122.12'"
            ),
            EXISTING_DEFAULT_WITHOUT_RUNNER.replace(
                "52:54:00:aa:bb:cc", "52:54:00:20:00:12"
            ),
            EXISTING_DEFAULT_WITHOUT_RUNNER.replace(
                "name='unrelated-vm'", "name='codestead-runner'"
            ),
            EXISTING_DEFAULT_WITH_UNRELATED.replace(
                "</dhcp>",
                "<host mac='52:54:00:20:00:12' name='codestead-runner' ip='192.168.122.12'/></dhcp>",
            ),
        ]
        for mutation in conflicts:
            with self.subTest(mutation=mutation[-150:]):
                self.assert_rejected(
                    module.validate_network_xml,
                    mutation,
                    "inactive",
                    "11111111-2222-4333-8444-555555555555",
                )

    def test_reservation_reconciliation_is_crash_resumable(self):
        cases = {
            (False, False, False): (True, False),
            (False, False, True): (True, True),
            (True, False, True): (False, True),
            (False, True, True): (True, False),
            (True, True, True): (False, False),
            (True, False, False): (False, False),
        }
        for state, expected in cases.items():
            with self.subTest(state=state):
                self.assertEqual(module.reservation_update_plan(*state), expected)
        self.assert_rejected(module.reservation_update_plan, False, True, False)

    def test_actual_network_convergence_clean_rerun_and_partial_live_repair(self):
        manifest_writes = []
        with mock.patch.object(
            module,
            "_atomic_write_manifest",
            side_effect=lambda _path, payload: manifest_writes.append(dict(payload)),
        ):
            clean = FakeDefaultNetworkRunner(
                EXISTING_DEFAULT_WITHOUT_RUNNER,
                active=False,
                autostart=False,
            )
            payload = {}
            network_uuid = module._converge_default_network(
                clean, payload, Path("ignored-manifest"), Path("ignored-network")
            )
            self.assertEqual(network_uuid, clean.uuid)
            self.assertTrue(clean.active and clean.autostart)
            mutations = [command[3] for command in clean.commands if command[3] in {"net-update", "net-start", "net-autostart"}]
            self.assertEqual(mutations, ["net-update", "net-autostart", "net-start"])
            self.assertFalse(any(action in {"destroy", "undefine", "net-destroy", "net-undefine"} for action in mutations))

            clean.commands.clear()
            module._converge_default_network(
                clean, payload, Path("ignored-manifest"), Path("ignored-network")
            )
            self.assertFalse(any(command[3] in {"net-update", "net-start", "net-autostart"} for command in clean.commands))

            partial = FakeDefaultNetworkRunner(
                EXISTING_DEFAULT_WITH_UNRELATED,
                active=True,
                autostart=True,
                live_xml=EXISTING_DEFAULT_WITHOUT_RUNNER,
            )
            partial_payload = {}
            module._converge_default_network(
                partial,
                partial_payload,
                Path("ignored-manifest"),
                Path("ignored-network"),
            )
            updates = [command for command in partial.commands if command[3] == "net-update"]
            self.assertEqual(len(updates), 1)
            self.assertIn("--live", updates[0])
            self.assertNotIn("--config", updates[0])
            self.assertEqual(updates[0][4], partial.uuid)
        self.assertTrue(manifest_writes)

    def test_network_name_replacement_race_fails_without_updating_replacement(self):
        race = FakeDefaultNetworkRunner(
            EXISTING_DEFAULT_WITHOUT_RUNNER,
            active=False,
            autostart=True,
        )
        original_xml = race.inactive_xml
        race.replace_uuid_before_update = True
        with mock.patch.object(module, "_atomic_write_manifest", return_value=None):
            self.assert_rejected(
                module._converge_default_network,
                race,
                {},
                Path("ignored-manifest"),
                Path("ignored-network"),
            )
        self.assertEqual(race.updates_applied, 0)
        self.assertEqual(race.inactive_xml, original_xml)
        update_commands = [command for command in race.commands if command[3] == "net-update"]
        self.assertEqual(len(update_commands), 1)
        self.assertEqual(update_commands[0][4], "11111111-2222-4333-8444-555555555555")

    def test_actual_domain_define_autostart_and_start_lifecycle_uses_no_destructive_action(self):
        fake = FakeDomainRunner()
        payload = {}
        with tempfile.TemporaryDirectory() as directory, mock.patch.object(
            module, "_require_ready_default_network", return_value=None
        ), mock.patch.object(
            module, "_atomic_write_manifest", return_value=None
        ), mock.patch.object(
            module, "_verify_storage", return_value=None
        ), mock.patch.object(
            module.os, "O_NOFOLLOW", getattr(module.os, "O_NOFOLLOW", 0), create=True
        ), mock.patch.object(
            module.os, "O_CLOEXEC", getattr(module.os, "O_CLOEXEC", 0), create=True
        ), portable_fake_fchmod():
            module._define_and_start_domain(
                fake,
                payload,
                Path(directory) / "manifest.json",
                "11111111-2222-4333-8444-555555555555",
                64055,
                108,
            )
        self.assertTrue(fake.defined and fake.autostart and fake.running)
        virt_install = [command for command in fake.commands if command[0] == "/usr/bin/virt-install"]
        self.assertEqual(virt_install, [EXPECTED_VIRT_INSTALL_ARGV])
        self.assertEqual(virt_install[0].count("--osinfo"), 1)
        mutations = [
            command[3]
            for command in fake.commands
            if command[0] == "/usr/bin/virsh" and command[3] in {"define", "autostart", "start"}
        ]
        self.assertEqual(mutations, ["define", "autostart", "start"])
        flattened = " ".join(" ".join(command) for command in fake.commands)
        for destructive in ("destroy", "undefine", "net-destroy", "net-undefine", "vol-delete"):
            self.assertNotIn(destructive, flattened)
        self.assertEqual(payload["phase"], "completed")

    def test_noble_virt_install_boundary_rejects_unreviewed_generation_drift(self):
        mutations = {
            "metadata-os-id": NOBLE_VIRT_INSTALL_4_1_0_DOMAIN.replace(
                "http://ubuntu.com/ubuntu/24.04", "http://attacker.invalid/os"
            ),
            "metadata-child": NOBLE_VIRT_INSTALL_4_1_0_DOMAIN.replace(
                "</metadata>", "<attacker/></metadata>"
            ),
            "default-rng": NOBLE_VIRT_INSTALL_4_1_0_DOMAIN.replace(
                "/dev/urandom", "/dev/random"
            ),
            "extra-device": NOBLE_VIRT_INSTALL_4_1_0_DOMAIN.replace(
                "</devices>", "<hostdev mode='subsystem' type='pci'/></devices>"
            ),
            "controller-model": NOBLE_VIRT_INSTALL_4_1_0_DOMAIN.replace(
                'model="pcie-root-port"', 'model="pci-bridge"', 1
            ),
            "controller-cardinality": NOBLE_VIRT_INSTALL_4_1_0_DOMAIN.replace(
                '    <controller type="pci" model="pcie-root-port"/>\n', "", 1
            ),
            "machine": NOBLE_VIRT_INSTALL_4_1_0_DOMAIN.replace(
                'machine="q35"', 'machine="pc"'
            ),
            "vcpu-value": NOBLE_VIRT_INSTALL_4_1_0_DOMAIN.replace(
                "<vcpu>4</vcpu>", "<vcpu>8</vcpu>"
            ),
            "vcpu-attributes": NOBLE_VIRT_INSTALL_4_1_0_DOMAIN.replace(
                "<vcpu>4</vcpu>", "<vcpu current='4'>4</vcpu>"
            ),
        }
        for label, generated_xml in mutations.items():
            with self.subTest(label=label), tempfile.TemporaryDirectory() as directory:
                fake = FakeDomainRunner(generated_xml=generated_xml)
                with mock.patch.object(
                    module, "_require_ready_default_network", return_value=None
                ), mock.patch.object(
                    module, "_atomic_write_manifest", return_value=None
                ), mock.patch.object(
                    module, "_verify_storage", return_value=None
                ), mock.patch.object(
                    module.os, "O_NOFOLLOW", getattr(module.os, "O_NOFOLLOW", 0), create=True
                ), mock.patch.object(
                    module.os, "O_CLOEXEC", getattr(module.os, "O_CLOEXEC", 0), create=True
                ):
                    self.assert_rejected(
                        module._define_and_start_domain,
                        fake,
                        {},
                        Path(directory) / "manifest.json",
                        "11111111-2222-4333-8444-555555555555",
                        64055,
                        108,
                    )
                self.assertFalse(fake.defined)
                self.assertFalse(
                    any(
                        command[0] == "/usr/bin/virsh" and command[3] == "define"
                        for command in fake.commands
                    )
                )
    def test_integrated_transaction_clean_rerun_and_domain_cutpoint_recovery(self):
        for cutpoint in (None, "define", "autostart", "start"):
            with self.subTest(cutpoint=cutpoint), tempfile.TemporaryDirectory() as directory:
                payload = {"transaction_id": "a" * 32, "phase": "prepared"}
                fake = FakeIntegratedRunner(crash_after=cutpoint)
                manifest = Path(directory) / "transaction.json"

                def portable_open(path, *, expected_sha256, immutable, maximum_bytes=None):
                    del immutable
                    candidate = Path(path)
                    data = candidate.read_bytes()
                    if maximum_bytes is not None and len(data) > maximum_bytes:
                        raise ContractError("portable fake source exceeded its bound")
                    digest = module.hashlib.sha256(data).hexdigest()
                    if expected_sha256 is not None and digest != expected_sha256:
                        raise ContractError("portable fake source digest mismatch")
                    descriptor = module.os.open(candidate, module.os.O_RDONLY)
                    identity = module.FileIdentity.from_stat(module.os.fstat(descriptor), digest)
                    return descriptor, identity, data if maximum_bytes is not None else None

                patches = (
                    mock.patch.object(module, "_preflight_kvm_and_storage", return_value=(64055, 108)),
                    mock.patch.object(module, "_preflight_owned_artifacts", return_value=None),
                    mock.patch.object(module, "_prepare_and_publish_artifacts", return_value=None),
                    mock.patch.object(module, "_verify_storage", return_value=None),
                    mock.patch.object(module, "_atomic_write_manifest", return_value=None),
                    mock.patch.object(module, "open_verified_source", side_effect=portable_open),
                    mock.patch.object(module.os, "O_NOFOLLOW", getattr(module.os, "O_NOFOLLOW", 0), create=True),
                    mock.patch.object(
                        module.os,
                        "O_CLOEXEC",
                        getattr(module.os, "O_CLOEXEC", getattr(module.os, "O_BINARY", 0)),
                        create=True,
                    ),
                    portable_fake_fchmod(),
                )
                with patches[0], patches[1], patches[2], patches[3], patches[4], patches[5], patches[6], patches[7], patches[8]:
                    if cutpoint is None:
                        module._run_libvirt_transaction(
                            fake,
                            {},
                            payload,
                            manifest,
                            {"network": NETWORK.encode(), "meta": b"", "user": b""},
                            b"",
                            -1,
                        )
                    else:
                        with self.assertRaisesRegex(ContractError, f"simulated lifecycle cut after {cutpoint}"):
                            module._run_libvirt_transaction(
                                fake,
                                {},
                                payload,
                                manifest,
                                {"network": NETWORK.encode(), "meta": b"", "user": b""},
                                b"",
                                -1,
                            )
                        module._run_libvirt_transaction(
                            fake,
                            {},
                            payload,
                            manifest,
                            {"network": NETWORK.encode(), "meta": b"", "user": b""},
                            b"",
                            -1,
                        )
                    # A compatible completed rerun must be inspection-only.
                    mutation_count = len([
                        command
                        for command in fake.commands
                        if (command[0] == "/usr/bin/virsh" and command[3] in {"net-update", "net-autostart", "net-start", "define", "autostart", "start"})
                    ])
                    module._run_libvirt_transaction(
                        fake,
                        {},
                        payload,
                        manifest,
                        {"network": NETWORK.encode(), "meta": b"", "user": b""},
                        b"",
                        -1,
                    )
                    self.assertEqual(
                        mutation_count,
                        len([
                            command
                            for command in fake.commands
                            if (command[0] == "/usr/bin/virsh" and command[3] in {"net-update", "net-autostart", "net-start", "define", "autostart", "start"})
                        ]),
                    )
                self.assertEqual(payload["phase"], "completed")
                flattened = " ".join(" ".join(command) for command in fake.commands)
                for destructive in (" destroy ", " undefine ", " net-destroy ", " net-undefine ", " vol-delete "):
                    self.assertNotIn(destructive, f" {flattened} ")

    def test_active_leases_reject_target_ip_or_mac_conflicts(self):
        header = """ Expiry Time           MAC address         Protocol   IP address           Hostname        Client ID or DUID
-------------------------------------------------------------------------------------------------------------------
"""
        safe = header + " 2026-07-17 12:00:00   52:54:00:aa:bb:cc   ipv4       192.168.122.50/24    unrelated-vm    01:52:54:00:aa:bb:cc\n"
        target = header + " 2026-07-17 12:00:00   52:54:00:20:00:12   ipv4       192.168.122.12/24    codestead-runner  01:52:54:00:20:00:12\n"
        module.validate_default_network_leases(safe)
        module.validate_default_network_leases(target)
        self.assert_rejected(
            module.validate_default_network_leases,
            safe.replace("192.168.122.50/24", "192.168.122.12/24"),
        )
        self.assert_rejected(
            module.validate_default_network_leases,
            safe.replace("52:54:00:aa:bb:cc", "52:54:00:20:00:12"),
        )

    def test_inactive_and_live_domain_are_semantically_valid(self):
        module.validate_domain_xml(INACTIVE_DOMAIN, "inactive", "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee")
        module.validate_domain_xml(
            LIVE_DOMAIN,
            "live",
            "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee",
            64055,
            108,
        )
        self.assert_rejected(
            module.validate_domain_xml,
            LIVE_DOMAIN,
            "live",
            "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee",
        )

    def test_domain_rejects_reduced_resources_and_extra_devices(self):
        mutations = [
            INACTIVE_DOMAIN.replace("current='4'", "current='1'"),
            INACTIVE_DOMAIN.replace("<currentMemory unit='KiB'>8388608", "<currentMemory unit='KiB'>524288"),
            INACTIVE_DOMAIN.replace("</devices>", "<disk type='file' device='disk'><source file='/tmp/extra'/><target dev='vdb' bus='virtio'/></disk></devices>"),
            INACTIVE_DOMAIN.replace("</devices>", "<interface type='bridge'><source bridge='public'/><model type='virtio'/></interface></devices>"),
            INACTIVE_DOMAIN.replace("</devices>", "<hostdev mode='subsystem' type='pci'/></devices>"),
            INACTIVE_DOMAIN.replace("</devices>", "<filesystem type='mount'><source dir='/home'/><target dir='host'/></filesystem></devices>"),
            INACTIVE_DOMAIN.replace("<serial type='pty'>", "<serial type='file'><source path='/etc/shadow'/>", 1),
            INACTIVE_DOMAIN.replace("</os>", "<kernel>/etc/shadow</kernel></os>"),
            INACTIVE_DOMAIN.replace("/usr/bin/qemu-system-x86_64", "/tmp/attacker-emulator"),
            INACTIVE_DOMAIN.replace("</devices>", "<graphics type='vnc' listen='0.0.0.0'/></devices>"),
            INACTIVE_DOMAIN.replace("</devices>", "<rng model='virtio'><backend model='random'>/dev/random</backend></rng></devices>"),
        ]
        for mutation in mutations:
            with self.subTest(mutation=mutation[-120:]):
                self.assert_rejected(module.validate_domain_xml, mutation, "inactive", "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee")

    def test_domain_rejects_unreviewed_optional_security_and_lifecycle_state(self):
        mutations = [
            INACTIVE_DOMAIN.replace("<seclabel type='dynamic' model='apparmor' relabel='yes'/>", "<seclabel type='none'/>") ,
            INACTIVE_DOMAIN.replace("model='apparmor'", "model='dac'"),
            INACTIVE_DOMAIN.replace(
                "<seclabel type='dynamic' model='apparmor' relabel='yes'/>",
                "<seclabel type='dynamic' model='dac' relabel='yes'><label>0:0</label></seclabel>",
            ),
            INACTIVE_DOMAIN.replace(
                "<seclabel type='dynamic' model='apparmor' relabel='yes'/>",
                "<seclabel type='dynamic' model='apparmor' relabel='yes'><baselabel>libvirt-base</baselabel></seclabel>",
            ),
            INACTIVE_DOMAIN.replace(
                "<seclabel type='dynamic' model='apparmor' relabel='yes'/>",
                "<seclabel type='dynamic' model='apparmor' relabel='yes'><label>libvirt-attacker</label></seclabel>",
            ),
            INACTIVE_DOMAIN.replace("<on_crash>destroy</on_crash>", "<on_crash>preserve</on_crash>"),
            INACTIVE_DOMAIN.replace("<devices>", "<resource><partition>/machine</partition></resource><devices>"),
            INACTIVE_DOMAIN.replace("<devices>", "<resource><partition>/attacker</partition></resource><devices>"),
            INACTIVE_DOMAIN.replace("<devices>", "<sysinfo type='smbios'/><devices>"),
            INACTIVE_DOMAIN.replace("<features>", "<features><hyperv/>", 1),
            INACTIVE_DOMAIN.replace("<clock offset='utc'>", "<clock offset='localtime'>"),
            INACTIVE_DOMAIN.replace("<timer name='hpet' present='no'/>", ""),
            INACTIVE_DOMAIN.replace("placement='static' current='4'", "placement='static' current='4' cpuset='0'"),
            INACTIVE_DOMAIN.replace("check='none' migratable='on'", "check='none' migratable='off'"),
            INACTIVE_DOMAIN.replace("machine='pc-q35-8.2'", "machine='pc-q35-9.0'"),
            INACTIVE_DOMAIN.replace("<suspend-to-mem enabled='no'/>", "<suspend-to-mem enabled='yes'/>") ,
            INACTIVE_DOMAIN.replace("  <clock offset='utc'><timer name='rtc' tickpolicy='catchup'/><timer name='pit' tickpolicy='delay'/><timer name='hpet' present='no'/></clock>\n", ""),
            INACTIVE_DOMAIN.replace("  <on_poweroff>destroy</on_poweroff><on_reboot>restart</on_reboot><on_crash>destroy</on_crash>\n", ""),
            INACTIVE_DOMAIN.replace("  <pm><suspend-to-mem enabled='no'/><suspend-to-disk enabled='no'/></pm>\n", ""),
            INACTIVE_DOMAIN.replace("  <seclabel type='dynamic' model='apparmor' relabel='yes'/>\n", ""),
            INACTIVE_DOMAIN.replace(
                "<controller type='sata' index='0'/>",
                "<controller type='sata' index='7'/>",
            ),
            INACTIVE_DOMAIN.replace(
                "<controller type='sata' index='0'/>",
                "<controller type='sata' index='0'/><controller type='usb' index='0' model='qemu-xhci' ports='15'/>",
            ),
            INACTIVE_DOMAIN.replace("<memballoon model='virtio'/>", "<memballoon model='none'/>") ,
            INACTIVE_DOMAIN.replace("<memballoon model='virtio'/>", "<memballoon model='virtio' autodeflate='off'/>") ,
            INACTIVE_DOMAIN.replace("<memballoon model='virtio'/>", "<memballoon model='virtio'><stats period='5'/></memballoon>")
        ]
        for mutation in mutations:
            with self.subTest(mutation=mutation[-160:]):
                self.assert_rejected(
                    module.validate_domain_xml,
                    mutation,
                    "inactive",
                    "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee",
                )

        down = LIVE_DOMAIN.replace(
            "<source network='default' bridge='virbr0' portid='12345678-1234-4234-8234-123456789abc'/>",
            "<source network='default' bridge='virbr0' portid='12345678-1234-4234-8234-123456789abc'/><link state='down'/>",
        )
        self.assert_rejected(
            module.validate_domain_xml,
            down,
            "live",
            "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee",
            64055,
            108,
        )
        wrong_live_label = LIVE_DOMAIN.replace(
            "libvirt-aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee",
            "libvirt-11111111-2222-4333-8444-555555555555",
        )
        self.assert_rejected(
            module.validate_domain_xml,
            wrong_live_label,
            "live",
            "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee",
            64055,
            108,
        )
        live_security_mutations = [
            LIVE_DOMAIN.replace(LIVE_APPARMOR_SECLABEL, ""),
            LIVE_DOMAIN.replace(LIVE_DAC_SECLABEL, ""),
            LIVE_DOMAIN.replace("+64055:+108", "+0:+0"),
            LIVE_DOMAIN.replace(LIVE_DAC_SECLABEL, LIVE_DAC_SECLABEL * 2),
            LIVE_DOMAIN.replace(LIVE_APPARMOR_SECLABEL, LIVE_APPARMOR_SECLABEL * 2),
            LIVE_DOMAIN.replace(
                LIVE_DAC_SECLABEL,
                LIVE_DAC_SECLABEL
                + "<seclabel type='dynamic' model='selinux' relabel='yes'>"
                + "<label>system_u:system_r:svirt_t:s0</label>"
                + "<imagelabel>system_u:object_r:svirt_image_t:s0</imagelabel>"
                + "</seclabel>",
            ),
            LIVE_DOMAIN.replace("model='apparmor'", "model='dac'", 1),
            LIVE_DOMAIN.replace(
                "<label>+64055:+108</label>",
                "<baselabel>+64055:+108</baselabel><label>+64055:+108</label>",
            ),
        ]
        for mutation in live_security_mutations:
            with self.subTest(live_security_mutation=mutation[-240:]):
                self.assert_rejected(
                    module.validate_domain_xml,
                    mutation,
                    "live",
                    "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee",
                    64055,
                    108,
                )

    def test_command_runner_uses_incremental_bounded_pipe_collection(self):
        source = inspect.getsource(module.CommandRunner.run)
        self.assertNotIn(".communicate(input_text, timeout=timeout)", source)
        self.assertIn("selectors.DefaultSelector", source)
        self.assertIn("OUTPUT_LIMIT_BYTES", source)
        self.assertIn("_terminate_process_group", source)

    def test_signal_during_spawn_publication_cleans_the_exact_new_group(self):
        class FakeStream:
            def __init__(self, descriptor):
                self.descriptor = descriptor
                self.closed = False

            def fileno(self):
                return self.descriptor

            def close(self):
                self.closed = True

        class SpawnedProcess:
            pid = 4242
            stdin = None
            stdout = FakeStream(101)
            stderr = FakeStream(102)
            returncode = 0

            def poll(self):
                return self.returncode

            def wait(self, timeout):
                del timeout
                return self.returncode

        class EmptySelector:
            def register(self, *_args):
                return None

            def get_map(self):
                return {}

            def close(self):
                return None

        runner = module.CommandRunner({"query_seconds": 2, "kill_after_seconds": 0})
        process = SpawnedProcess()
        spawn_events = []
        delivered = []

        def observe_before_publication(spawned):
            spawn_events.append((spawned.pid, runner.current))
            self.assertIs(runner.terminate_current(), False)

        def fake_popen(_argv, **kwargs):
            spawn_events.append(("start-new-session", kwargs.get("start_new_session")))
            return process

        def fake_killpg(pid, signum):
            delivered.append((pid, signum))
            if signum == 0:
                raise ProcessLookupError

        runner._spawn_publication_observer = observe_before_publication
        with mock.patch.object(module.subprocess, "Popen", side_effect=fake_popen), mock.patch.object(
            module.selectors, "DefaultSelector", return_value=EmptySelector()
        ), mock.patch.object(
            module.os, "set_blocking", return_value=None, create=True
        ), mock.patch.object(
            module.os, "killpg", side_effect=fake_killpg, create=True
        ), mock.patch.object(
            module.signal, "SIGTERM", 15, create=True
        ), mock.patch.object(
            module.signal, "SIGKILL", 9, create=True
        ):
            with self.assertRaisesRegex(ContractError, "interrupted during process publication"):
                runner.run(["/usr/bin/true"])
        self.assertEqual(
            spawn_events,
            [("start-new-session", True), (4242, None)],
        )
        self.assertEqual(delivered, [(4242, 15), (4242, 0)])
        self.assertIsNone(runner.current)

    def test_signal_cleanup_escalates_from_term_to_kill_for_a_stuck_group(self):
        class HungProcess:
            pid = 4242

            def poll(self):
                return None

        runner = module.CommandRunner({"query_seconds": 2, "kill_after_seconds": 0})
        process = HungProcess()
        runner.current = process
        delivered = []
        group_alive = True

        def fake_killpg(pid, signum):
            nonlocal group_alive
            delivered.append((pid, signum))
            if signum == 0 and not group_alive:
                raise ProcessLookupError
            if signum == 9:
                group_alive = False

        with mock.patch.object(
            module.os,
            "killpg",
            side_effect=fake_killpg,
            create=True,
        ), mock.patch.object(module.signal, "SIGTERM", 15, create=True), mock.patch.object(
            module.signal, "SIGKILL", 9, create=True
        ):
            runner.terminate_current()
        self.assertEqual(delivered, [(4242, 15), (4242, 0), (4242, 9), (4242, 0)])

    def test_output_cleanup_kills_descendant_group_after_parent_exits(self):
        class ExitedParent:
            pid = 4343

            def poll(self):
                return 0

            def wait(self, timeout):
                del timeout
                return 0

        runner = module.CommandRunner({"query_seconds": 2, "kill_after_seconds": 0})
        runner.current = ExitedParent()
        delivered = []
        group_alive = True

        def fake_killpg(pid, signum):
            nonlocal group_alive
            delivered.append((pid, signum))
            if signum == 0 and not group_alive:
                raise ProcessLookupError
            if signum == 9:
                group_alive = False

        with mock.patch.object(module.os, "killpg", side_effect=fake_killpg, create=True), mock.patch.object(
            module.signal, "SIGTERM", 15, create=True
        ), mock.patch.object(module.signal, "SIGKILL", 9, create=True):
            runner.terminate_current()
        self.assertIn((4343, 15), delivered)
        self.assertIn((4343, 9), delivered)
        last_probe = max(index for index, event in enumerate(delivered) if event == (4343, 0))
        self.assertGreater(last_probe, delivered.index((4343, 9)))
        self.assertNotIn("poll() is None", inspect.getsource(module.CommandRunner.terminate_current))

    def test_signal_cleanup_rejects_a_group_that_survives_sigkill(self):
        class ExitedParent:
            pid = 4444

            def poll(self):
                return 0

        runner = module.CommandRunner({"query_seconds": 2, "kill_after_seconds": 0})
        runner.current = ExitedParent()
        delivered = []

        with mock.patch.object(
            module.os,
            "killpg",
            side_effect=lambda pid, signum: delivered.append((pid, signum)),
            create=True,
        ), mock.patch.object(module.signal, "SIGTERM", 15, create=True), mock.patch.object(
            module.signal, "SIGKILL", 9, create=True
        ):
            with self.assertRaisesRegex(ContractError, "survived SIGKILL"):
                runner.terminate_current()
        self.assertEqual(delivered, [(4444, 15), (4444, 0), (4444, 9), (4444, 0)])

    def test_signal_cleanup_stops_after_group_disappears_before_id_reuse(self):
        class ExitedParent:
            pid = 4545

            def poll(self):
                return 0

        runner = module.CommandRunner({"query_seconds": 2, "kill_after_seconds": 0})
        runner.current = ExitedParent()
        delivered = []

        def disappearing_group(pid, signum):
            delivered.append((pid, signum))
            if signum == 0:
                raise ProcessLookupError

        with mock.patch.object(
            module.os, "killpg", side_effect=disappearing_group, create=True
        ), mock.patch.object(module.signal, "SIGTERM", 15, create=True), mock.patch.object(
            module.signal, "SIGKILL", 9, create=True
        ):
            runner.terminate_current()
        self.assertEqual(delivered, [(4545, 15), (4545, 0)])
        cleanup_source = inspect.getsource(module.CommandRunner._terminate_process_group)
        self.assertNotIn("os.getpgid", cleanup_source)

    def test_signal_cleanup_reaps_an_already_absent_group_leader(self):
        class ExitedParent:
            pid = 4646

            def __init__(self):
                self.poll_calls = 0

            def poll(self):
                self.poll_calls += 1
                return 0

        process = ExitedParent()
        runner = module.CommandRunner({"query_seconds": 2, "kill_after_seconds": 0})
        runner.current = process
        delivered = []

        def absent_group(pid, signum):
            delivered.append((pid, signum))
            raise ProcessLookupError

        with mock.patch.object(
            module.os, "killpg", side_effect=absent_group, create=True
        ):
            runner.terminate_current()
        self.assertEqual(delivered, [(4646, module.signal.SIGTERM)])
        self.assertEqual(process.poll_calls, 1)

    def test_linux_root_self_test_covers_a_real_descendant_group(self):
        source = inspect.getsource(module._self_test_linux)
        self.assertIn("real-descendant-pid", source)
        self.assertIn("real descendant process group survived cleanup", source)

    def test_actual_wrapper_timeout_probe_covers_exited_leader_and_stubborn_descendant(self):
        source = helper_path.read_text(encoding="utf-8")
        self.assertIn("def _self_test_wrapper_timeout", source)
        self.assertIn("wrapper-timeout-cleanup-ok", source)
        self.assertIn("wrapper timeout leader had not exited", source)
        self.assertIn("signal.signal(signal.SIGTERM, signal.SIG_IGN)", source)
        self.assertIn(
            "_load_contract(Path(arguments.contract), arguments.contract_sha256)",
            source,
        )
        self.assertIn("wrapper timeout descendant process group survived cleanup", source)

    def test_actual_wrapper_timeout_probe_covers_spawn_publication_boundary(self):
        source = helper_path.read_text(encoding="utf-8")
        self.assertIn("def _self_test_wrapper_spawn_boundary", source)
        self.assertIn("_spawn_publication_observer", source)
        self.assertIn("wrapper-spawn-publication-cleanup-ok", source)
        self.assertIn("wrapper spawn-publication cleanup completed after signal", source)

    def test_missing_kvm_fails_as_a_closed_contract_error(self):
        with mock.patch.object(module.os, "lstat", side_effect=FileNotFoundError("missing /dev/kvm")):
            self.assert_rejected(module._preflight_kvm_and_storage, object())

    def test_wrong_source_sha_fails_before_verified_bytes_are_returned(self):
        with tempfile.TemporaryDirectory() as directory:
            source = Path(directory) / "base.img"
            source.write_bytes(b"reviewed-base-image")
            with mock.patch.object(module, "attest_trusted_file", return_value=None), mock.patch.object(
                module.os, "O_NOFOLLOW", getattr(module.os, "O_NOFOLLOW", 0), create=True
            ), mock.patch.object(
                module.os,
                "O_CLOEXEC",
                getattr(module.os, "O_CLOEXEC", getattr(module.os, "O_BINARY", 0)),
                create=True,
            ):
                self.assert_rejected(
                    module.open_verified_source,
                    source,
                    expected_sha256="0" * 64,
                    immutable=False,
                    maximum_bytes=1024,
                )

    def test_network_update_command_is_bound_to_captured_uuid(self):
        captured = "11111111-2222-4333-8444-555555555555"
        command = module.build_network_update_command(captured, True, True)
        self.assertEqual(command[3], "net-update")
        self.assertEqual(command[4], captured)
        self.assertNotIn("default", command[4:6])
        self.assertIn("--config", command)
        self.assertIn("--live", command)

    def test_publication_implementation_places_durability_before_rename(self):
        source = inspect.getsource(module.rename_noreplace)
        self.assertIn("publication_checkpoint", source)
        self.assertLess(source.index('publication_checkpoint("stage-fsynced")'), source.index("_renameat2_noreplace"))
        self.assertLess(source.index("_renameat2_noreplace"), source.index('publication_checkpoint("destination-directory-fsynced")'))

    def test_inactive_definition_drift_is_rejected_even_if_live_is_valid(self):
        drift = INACTIVE_DOMAIN.replace("network='default'", "network='codestead-runner'")
        self.assert_rejected(module.validate_domain_xml, drift, "inactive", "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee")

    def test_image_json_is_strict_and_has_no_backing_encryption_or_snapshots(self):
        module.parse_image_info(json.dumps(GOOD_IMAGE, indent=2), GOOD_IMAGE["filename"])
        for key, value in [
            ("backing-filename", "/tmp/attacker.img"),
            ("encrypted", True),
            ("snapshots", [{"id": "1", "name": "hidden"}]),
        ]:
            mutation = dict(GOOD_IMAGE)
            mutation[key] = value
            with self.subTest(key=key):
                self.assert_rejected(module.parse_image_info, json.dumps(mutation), GOOD_IMAGE["filename"])
        self.assert_rejected(module.parse_image_info, '{"format":"qcow2","format":"raw","virtual-size":107374182400}', GOOD_IMAGE["filename"])
        self.assert_rejected(module.parse_image_info, '{"format":"qcow2","virtual-size":107374182400,"x":BROKEN}', GOOD_IMAGE["filename"])
        self.assert_rejected(module.parse_image_info, json.dumps({**GOOD_IMAGE, "encrypted": []}), GOOD_IMAGE["filename"])

        base = {**GOOD_IMAGE, "filename": "/proc/self/fd/17", "virtual-size": 2361393152}
        module.validate_base_image_info(json.dumps(base), "/proc/self/fd/17")
        for mutation in (
            {**base, "backing-filename": "/etc/shadow"},
            {**base, "encrypted": True},
            {**base, "format": "raw"},
        ):
            self.assert_rejected(
                module.validate_base_image_info,
                json.dumps(mutation),
                "/proc/self/fd/17",
            )

    def test_ssh_key_policy_rejects_parser_failure_and_weak_keys(self):
        accepted = module.validate_ssh_key_report(
            "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIAABAgMEBQYHCAkKCwwNDg8QERITFBUWFxgZGhscHR4f runner",
            "256 SHA256:abcdefghijklmnopqrstuvwxzy0123456789ABCD runner (ED25519)",
        )
        self.assertEqual(accepted["algorithm"], "ED25519")
        rejected = [
            ("ssh-ed25519 =", "not a public key file"),
            ("ssh-rsa AAAA", "2048 SHA256:abc weak (RSA)"),
            ("ssh-dss AAAA", "1024 SHA256:abc weak (DSA)"),
        ]
        for key, report in rejected:
            with self.subTest(key=key):
                self.assert_rejected(module.validate_ssh_key_report, key, report)

    def test_manifest_integrity_detects_tampering(self):
        payload = {"version": 1, "phase": "prepared", "transaction_id": "a" * 32}
        sealed = module.seal_transaction_manifest(payload)
        self.assertEqual(module.verify_transaction_manifest(sealed), payload)
        sealed["phase"] = "completed"
        self.assert_rejected(module.verify_transaction_manifest, sealed)

    def test_every_owned_cut_point_is_resumable_and_unknown_orphans_fail(self):
        cases = {
            ("prepared", "owned", "missing", "owned", "missing", False): "publish-disk",
            ("publishing-disk", "missing", "owned", "owned", "missing", False): "publish-seed",
            ("publishing-seed", "missing", "owned", "missing", "owned", False): "define-domain",
            ("defining-domain", "missing", "owned", "missing", "owned", True): "configure-domain",
            ("configuring-domain", "missing", "owned", "missing", "owned", True): "configure-domain",
            ("completed", "missing", "owned", "missing", "owned", True): "verify-complete",
        }
        for state, expected in cases.items():
            with self.subTest(state=state):
                self.assertEqual(module.reconcile_transaction_state(*state), expected)
        self.assert_rejected(module.reconcile_transaction_state, "prepared", "missing", "unknown", "missing", "missing", False)
        self.assert_rejected(module.reconcile_transaction_state, "prepared", "missing", "missing", "missing", "unknown", False)

    def test_persistent_libvirt_info_and_inactive_block_sources_are_exact(self):
        network_info = """Name: default
UUID: 11111111-2222-4333-8444-555555555555
Active: yes
Persistent: yes
Autostart: yes
Bridge: virbr0
"""
        domain_info = """Id: 7
Name: codestead-runner
UUID: aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee
State: running
CPU(s): 4
Max memory: 8388608 KiB
Used memory: 8388608 KiB
Persistent: yes
Autostart: enable
"""
        self.assertTrue(module.parse_virsh_info(network_info, "network")["persistent"])
        self.assertTrue(module.parse_virsh_info(domain_info, "domain")["persistent"])
        self.assert_rejected(module.parse_virsh_info, network_info.replace("Persistent: yes", "Persistent: no"), "network")
        self.assert_rejected(module.parse_virsh_info, domain_info.replace("Persistent: yes", "Persistent: no"), "domain")
        blocks = """ Type   Device   Target   Source
---------------------------------------------------------------
 file   disk     vda      /var/lib/libvirt/images/codestead-runner.qcow2
 file   cdrom    sda      /var/lib/libvirt/boot/codestead-runner-seed.iso
"""
        module.parse_inactive_block_list(blocks)
        self.assert_rejected(module.parse_inactive_block_list, blocks + " file disk vdb /tmp/extra.qcow2\n")

    def test_name_list_rejects_duplicate_or_malformed_identity(self):
        self.assertTrue(module.exact_name_is_present("codestead-runner\n", "codestead-runner"))
        self.assertFalse(module.exact_name_is_present("portfolio\n", "codestead-runner"))
        self.assert_rejected(module.exact_name_is_present, "codestead-runner\ncodestead-runner\n", "codestead-runner")
        self.assert_rejected(module.exact_name_is_present, "codestead-runner extra\n", "codestead-runner")


suite = unittest.defaultTestLoader.loadTestsFromTestCase(SemanticContractTests)
result = unittest.TextTestRunner(verbosity=2).run(suite)
raise SystemExit(0 if result.wasSuccessful() else 1)
PY

# Authoritative ownership, renameat2, deadline, lock, signal, and fake-libvirt
# lifecycle tests require Linux root. Portable runs deliberately stop here.
if [[ "$(uname -s 2>/dev/null || true)" != Linux || "${EUID:-1}" != 0 ]]; then
  printf '%s\n' 'runner-vm-portable-contract-tests-ok; authoritative-linux-root-gate-required'
  exit 0
fi

bootstrap_test_root="$(mktemp -d /root/codestead-bootstrap-test.XXXXXX)"
trap 'rm -rf -- "$bootstrap_test_root"' EXIT
install -m 0500 "$provisioner" "$bootstrap_test_root/provision-host.sh"
install -m 0400 "$contract" "$bootstrap_test_root/runner-contract.json"
install -m 0400 "$network" "$bootstrap_test_root/codestead-runner-network.xml"
mkdir -m 0700 "$bootstrap_test_root/cloud-init"
install -m 0400 "$meta" "$bootstrap_test_root/cloud-init/meta-data"
install -m 0400 "$user_data" "$bootstrap_test_root/cloud-init/user-data.template"
sentinel="$bootstrap_test_root/helper-ran"
{
  printf 'from pathlib import Path\n'
  printf 'Path("%s").write_text("UNTRUSTED", encoding="utf-8")\n' "$sentinel"
} >"$bootstrap_test_root/codestead_runner_provision.py"
chmod 0400 "$bootstrap_test_root/codestead_runner_provision.py"
if RUNNER_BASE_IMAGE_PATH="$bootstrap_test_root/nonexistent-image" \
  RUNNER_BASE_IMAGE_SHA256="$(printf '0%.0s' {1..64})" \
  RUNNER_ADMIN_SSH_PUBLIC_KEY_FILE="$bootstrap_test_root/nonexistent-key" \
  "$bootstrap_test_root/provision-host.sh" >/dev/null 2>&1; then
  fail 'tampered helper unexpectedly passed the trusted bootstrap'
fi
[[ ! -e "$sentinel" ]] || fail 'tampered helper executed a top-level side effect before digest verification'
rm -rf -- "$bootstrap_test_root"
trap - EXIT

wrapper_test_root="$(mktemp -d /root/codestead-wrapper-timeout-test.XXXXXX)"
trap 'rm -rf -- "$wrapper_test_root"' EXIT
mkdir -m 0700 "$wrapper_test_root/cloud-init"
install -m 0400 "$helper" "$wrapper_test_root/codestead_runner_provision.py"
install -m 0400 "$contract" "$wrapper_test_root/runner-contract.json"
install -m 0400 "$network" "$wrapper_test_root/codestead-runner-network.xml"
install -m 0400 "$meta" "$wrapper_test_root/cloud-init/meta-data"
install -m 0400 "$user_data" "$wrapper_test_root/cloud-init/user-data.template"
"$python_bin" - "$provisioner" "$wrapper_test_root/provision-host.sh" <<'PY'
from pathlib import Path
import sys

source_path, destination_path = map(Path, sys.argv[1:])
source = source_path.read_text(encoding="utf-8")
total_token = " 600s " + chr(92) + "\n"
mode_token = '"$helper_sha256" provision ' + chr(92) + "\n"
if source.count(total_token) != 1 or source.count(mode_token) != 1:
    raise SystemExit("production wrapper timeout fixture tokens drifted")
source = source.replace(" 600s " + chr(92) + "\n", " 1s " + chr(92) + "\n", 1)
source = source.replace(
    '"$helper_sha256" provision ' + chr(92) + "\n",
    '"$helper_sha256" self-test-wrapper-timeout ' + chr(92) + "\n",
    1,
)
destination_path.write_text(source, encoding="utf-8")
PY
chmod 0500 "$wrapper_test_root/provision-host.sh"
wrapper_output="$wrapper_test_root/wrapper-timeout.output"
wrapper_started=$SECONDS
set +e
RUNNER_BASE_IMAGE_PATH="$wrapper_test_root/nonexistent-image" \
  RUNNER_BASE_IMAGE_SHA256="$(printf '0%.0s' {1..64})" \
  RUNNER_ADMIN_SSH_PUBLIC_KEY_FILE="$wrapper_test_root/nonexistent-key" \
  "$wrapper_test_root/provision-host.sh" >"$wrapper_output" 2>&1
wrapper_status=$?
set -e
wrapper_elapsed=$((SECONDS - wrapper_started))
(( wrapper_status == 124 )) ||
  fail "shortened actual-wrapper timeout returned $wrapper_status instead of the fail-closed timeout status"
grep -Fq 'ERROR: wrapper timeout cleanup completed after signal 15' "$wrapper_output" ||
  fail 'outer watchdog preempted the helper before its full cleanup proof completed'
wrapper_pgid="$(sed -n 's/^wrapper-timeout-cleanup-ok pgid=\([1-9][0-9]*\) leader=exited$/\1/p' "$wrapper_output")"
[[ "$wrapper_pgid" =~ ^[1-9][0-9]*$ ]] ||
  fail 'actual-wrapper timeout probe did not report one exited-leader process group'
if /usr/bin/kill -0 -- "-$wrapper_pgid" 2>/dev/null; then
  fail 'actual-wrapper timeout left the TERM-resistant descendant group alive'
fi
(( wrapper_elapsed >= 5 && wrapper_elapsed < 15 )) ||
  fail "actual-wrapper cleanup duration $wrapper_elapsed did not prove the outer watchdog margin"
rm -rf -- "$wrapper_test_root"
trap - EXIT

spawn_wrapper_test_root="$(mktemp -d /root/codestead-wrapper-spawn-test.XXXXXX)"
trap 'rm -rf -- "$spawn_wrapper_test_root"' EXIT
mkdir -m 0700 "$spawn_wrapper_test_root/cloud-init"
install -m 0400 "$helper" "$spawn_wrapper_test_root/codestead_runner_provision.py"
install -m 0400 "$contract" "$spawn_wrapper_test_root/runner-contract.json"
install -m 0400 "$network" "$spawn_wrapper_test_root/codestead-runner-network.xml"
install -m 0400 "$meta" "$spawn_wrapper_test_root/cloud-init/meta-data"
install -m 0400 "$user_data" "$spawn_wrapper_test_root/cloud-init/user-data.template"
"$python_bin" - "$provisioner" "$spawn_wrapper_test_root/provision-host.sh" <<'PY'
from pathlib import Path
import sys

source_path, destination_path = map(Path, sys.argv[1:])
source = source_path.read_text(encoding="utf-8")
total_token = " 600s " + chr(92) + "\n"
mode_token = '"$helper_sha256" provision ' + chr(92) + "\n"
if source.count(total_token) != 1 or source.count(mode_token) != 1:
    raise SystemExit("production wrapper spawn-boundary fixture tokens drifted")
source = source.replace(" 600s " + chr(92) + "\n", " 1s " + chr(92) + "\n", 1)
source = source.replace(
    '"$helper_sha256" provision ' + chr(92) + "\n",
    '"$helper_sha256" self-test-wrapper-spawn-boundary ' + chr(92) + "\n",
    1,
)
destination_path.write_text(source, encoding="utf-8")
PY
chmod 0500 "$spawn_wrapper_test_root/provision-host.sh"
spawn_wrapper_output="$spawn_wrapper_test_root/wrapper-spawn.output"
spawn_wrapper_started=$SECONDS
set +e
RUNNER_BASE_IMAGE_PATH="$spawn_wrapper_test_root/nonexistent-image" \
  RUNNER_BASE_IMAGE_SHA256="$(printf '0%.0s' {1..64})" \
  RUNNER_ADMIN_SSH_PUBLIC_KEY_FILE="$spawn_wrapper_test_root/nonexistent-key" \
  "$spawn_wrapper_test_root/provision-host.sh" >"$spawn_wrapper_output" 2>&1
spawn_wrapper_status=$?
set -e
spawn_wrapper_elapsed=$((SECONDS - spawn_wrapper_started))
(( spawn_wrapper_status == 124 )) ||
  fail "spawn-boundary actual-wrapper timeout returned $spawn_wrapper_status instead of 124"
grep -Fq 'ERROR: wrapper spawn-publication cleanup completed after signal 15' "$spawn_wrapper_output" ||
  fail 'spawn-boundary outer watchdog did not allow exact child-group cleanup to complete'
spawn_wrapper_pgid="$(sed -n 's/^wrapper-spawn-publication-cleanup-ok pgid=\([1-9][0-9]*\) current=cleared$/\1/p' "$spawn_wrapper_output")"
[[ "$spawn_wrapper_pgid" =~ ^[1-9][0-9]*$ ]] ||
  fail 'spawn-boundary actual-wrapper probe did not report one cleaned process group'
if /usr/bin/kill -0 -- "-$spawn_wrapper_pgid" 2>/dev/null; then
  fail 'spawn-boundary actual-wrapper timeout left the unpublished child group alive'
fi
(( spawn_wrapper_elapsed >= 5 && spawn_wrapper_elapsed < 15 )) ||
  fail "spawn-boundary cleanup duration $spawn_wrapper_elapsed did not prove the outer margin"
rm -rf -- "$spawn_wrapper_test_root"
trap - EXIT

"$python_bin" "$helper" self-test-linux --contract "$contract" --provisioner "$provisioner" \
  --network "$network" --meta-data "$meta" --user-data-template "$user_data"

printf '%s\n' 'runner-vm-provision-tests-ok'
