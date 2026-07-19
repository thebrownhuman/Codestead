#!/usr/bin/python3 -I
"""Fail-closed Codestead runner VM provisioning.

This module deliberately uses only the Python standard library.  The shell
entrypoint supplies a clean environment, a fixed interpreter, a total
deadline, and the expected helper/contract digests.  This module then attests
every source and external executable before performing any mutation.
"""

from __future__ import annotations

import argparse
import base64
import binascii
import ctypes
import dataclasses
import errno
import hashlib
import hmac
import ipaddress
import json
import os
import re
import selectors
import signal
import stat
import subprocess
import sys
import tempfile
import time
import uuid
import xml.etree.ElementTree as ET
from collections.abc import Callable, Iterable, Mapping, Sequence
from pathlib import Path
from typing import Any, Final

try:
    import fcntl
except ImportError:  # pragma: no cover - production is Linux-only
    fcntl = None  # type: ignore[assignment]


DOMAIN_NAME: Final = "codestead-runner"
NETWORK_NAME: Final = "default"
NETWORK_BRIDGE: Final = "virbr0"
NETWORK_HOST_IP: Final = "192.168.122.1"
NETWORK_NETMASK: Final = "255.255.255.0"
NETWORK_PREFIX: Final = "24"
EXPECTED_GUEST_IP: Final = "192.168.122.12"
EXPECTED_DHCP_START: Final = "192.168.122.2"
EXPECTED_DHCP_END: Final = "192.168.122.254"
DOMAIN_UUID_RE: Final = re.compile(
    r"^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$"
)
EXPECTED_DISK: Final = "/var/lib/libvirt/images/codestead-runner.qcow2"
EXPECTED_SEED: Final = "/var/lib/libvirt/boot/codestead-runner-seed.iso"
EXPECTED_MAC: Final = "52:54:00:20:00:12"
EXPECTED_OSINFO: Final = "ubuntu24.04"
EXPECTED_OSINFO_ID: Final = "http://ubuntu.com/ubuntu/24.04"
LIBOSINFO_NAMESPACE: Final = "http://libosinfo.org/xmlns/libvirt/domain/1.0"
VIRT_INSTALL_MACHINE: Final = "q35"
VIRT_INSTALL_PCIE_ROOT_PORTS: Final = 14
EXPECTED_MACHINE: Final = "pc-q35-8.2"
EXPECTED_MEMORY_BYTES: Final = 8 * 1024 * 1024 * 1024
EXPECTED_DISK_BYTES: Final = 100 * 1024 * 1024 * 1024
RENAME_NOREPLACE: Final = 1
AT_FDCWD: Final = -100


class ContractError(RuntimeError):
    """Raised when trusted provisioning cannot prove an exact contract."""


class CommandInterrupted(ContractError):
    """A handled signal deferred until one newly spawned group was owned."""

    def __init__(self, signum: int, process_group: int) -> None:
        self.signum = signum
        self.process_group = process_group
        super().__init__(
            f"external command interrupted during process publication by signal {signum}"
        )


def _unique_object(pairs: list[tuple[str, Any]]) -> dict[str, Any]:
    result: dict[str, Any] = {}
    for key, value in pairs:
        if key in result:
            raise ContractError(f"duplicate JSON key: {key}")
        result[key] = value
    return result


def parse_json_strict(text: str) -> Any:
    """Parse one JSON value while rejecting duplicate keys and trailing data."""

    try:
        decoder = json.JSONDecoder(object_pairs_hook=_unique_object)
        value, end = decoder.raw_decode(text.lstrip())
    except (json.JSONDecodeError, ContractError) as exc:
        raise ContractError(f"malformed JSON: {exc}") from exc
    leading = len(text) - len(text.lstrip())
    if text[leading + end :].strip():
        raise ContractError("JSON contains trailing data")
    return value


def _parse_xml(text: str, expected_root: str) -> ET.Element:
    try:
        root = ET.fromstring(text)
    except ET.ParseError as exc:
        raise ContractError(f"malformed XML: {exc}") from exc
    for element in root.iter():
        if element.tag.startswith("{") or ":" in element.tag:
            raise ContractError("XML namespaces are forbidden in the reviewed contract")
    if root.tag != expected_root:
        raise ContractError(f"expected XML root {expected_root!r}, got {root.tag!r}")
    return root


def _children(element: ET.Element, tag: str) -> list[ET.Element]:
    return [child for child in element if child.tag == tag]


def _one(element: ET.Element, tag: str) -> ET.Element:
    matches = _children(element, tag)
    if len(matches) != 1:
        raise ContractError(f"{element.tag} must contain exactly one {tag}")
    return matches[0]


def _optional_one(element: ET.Element, tag: str) -> ET.Element | None:
    matches = _children(element, tag)
    if len(matches) > 1:
        raise ContractError(f"{element.tag} contains duplicate {tag}")
    return matches[0] if matches else None


def _text(element: ET.Element) -> str:
    return (element.text or "").strip()


def _exact_attributes(
    element: ET.Element,
    required: Mapping[str, str],
    optional: Iterable[str] = (),
) -> None:
    allowed = set(required) | set(optional)
    if set(element.attrib) - allowed:
        raise ContractError(f"unexpected attributes on {element.tag}: {sorted(set(element.attrib) - allowed)}")
    for key, value in required.items():
        if element.get(key) != value:
            raise ContractError(f"{element.tag}.{key} must be {value!r}")


def _require_allowed_children(element: ET.Element, allowed: set[str]) -> None:
    unexpected = [child.tag for child in element if child.tag not in allowed]
    if unexpected:
        raise ContractError(f"unexpected children under {element.tag}: {unexpected}")


def _valid_uuid(value: str) -> bool:
    return bool(DOMAIN_UUID_RE.fullmatch(value))


def validate_osinfo_catalog(text: str) -> None:
    """Require the exact reviewed libosinfo short ID before any mutation."""

    token = re.compile(rf"(?<![A-Za-z0-9_.-]){re.escape(EXPECTED_OSINFO)}(?![A-Za-z0-9_.-])")
    if token.search(text) is None:
        raise ContractError(f"required virt-install OS identity is unavailable: {EXPECTED_OSINFO}")


def validate_network_xml(text: str, mode: str, expected_uuid: str | None) -> dict[str, Any]:
    """Validate the shared default NAT without rejecting unrelated DHCP hosts.

    The target reservation is the only mutable part owned by this provisioner.
    All other accepted semantics are fingerprinted so a concurrent change fails
    closed before another network mutation is attempted.
    """

    if mode not in {"source", "inactive", "live"}:
        raise ContractError(f"invalid network validation mode: {mode}")
    root = _parse_xml(text, "network")
    _exact_attributes(root, {}, {"connections"} if mode == "live" else set())
    if "connections" in root.attrib and not root.attrib["connections"].isdigit():
        raise ContractError("live network connections must be numeric")
    allowed = {"name", "forward", "bridge", "ip"}
    if mode != "source":
        allowed |= {"uuid", "mac"}
    _require_allowed_children(root, allowed)

    if _text(_one(root, "name")) != NETWORK_NAME:
        raise ContractError("network name drift")
    uuid_node = _optional_one(root, "uuid")
    if mode == "source":
        if uuid_node is not None or expected_uuid is not None:
            raise ContractError("reviewed source network must not carry a UUID")
    else:
        if uuid_node is None or not _valid_uuid(_text(uuid_node)):
            raise ContractError("persistent network has no valid UUID")
        if expected_uuid is not None and _text(uuid_node) != expected_uuid:
            raise ContractError("network UUID changed")

    forward = _one(root, "forward")
    _exact_attributes(forward, {"mode": "nat"})
    _require_allowed_children(forward, set())
    bridge = _one(root, "bridge")
    _exact_attributes(bridge, {"name": NETWORK_BRIDGE}, {"stp", "delay"})
    if bridge.get("stp", "on") != "on" or bridge.get("delay", "0") != "0":
        raise ContractError("network bridge policy drift")

    ip_nodes = _children(root, "ip")
    if len(ip_nodes) != 1:
        raise ContractError("default network must have exactly one reviewed IPv4 parent")
    ip_node = ip_nodes[0]
    _exact_attributes(ip_node, {"address": NETWORK_HOST_IP}, {"netmask", "prefix", "family"})
    if ip_node.get("family", "ipv4") != "ipv4":
        raise ContractError("default network IP family drift")
    netmask = ip_node.get("netmask")
    prefix = ip_node.get("prefix")
    if (netmask, prefix) not in {(NETWORK_NETMASK, None), (None, NETWORK_PREFIX)}:
        raise ContractError("default network prefix/netmask drift")
    _require_allowed_children(ip_node, {"dhcp"})
    dhcp = _one(ip_node, "dhcp")
    _exact_attributes(dhcp, {})
    _require_allowed_children(dhcp, {"range", "host"})

    subnet = ipaddress.ip_network(f"{NETWORK_HOST_IP}/{NETWORK_PREFIX}", strict=False)
    ranges: list[tuple[str, str]] = []
    for range_node in _children(dhcp, "range"):
        _exact_attributes(range_node, {}, {"start", "end"})
        try:
            start = ipaddress.ip_address(range_node.get("start", ""))
            end = ipaddress.ip_address(range_node.get("end", ""))
        except ValueError as exc:
            raise ContractError("default DHCP range is malformed") from exc
        if start not in subnet or end not in subnet or int(start) > int(end):
            raise ContractError("default DHCP range escapes the reviewed subnet")
        ranges.append((str(start), str(end)))
    if not ranges:
        raise ContractError("default network has no DHCP range")
    if len(set(ranges)) != len(ranges):
        raise ContractError("default network contains duplicate DHCP ranges")

    target = (EXPECTED_MAC, EXPECTED_GUEST_IP, DOMAIN_NAME)
    target_count = 0
    unrelated: list[tuple[str, str, str]] = []
    seen_macs: set[str] = set()
    seen_ips: set[str] = set()
    seen_names: set[str] = set()
    for host in _children(dhcp, "host"):
        _exact_attributes(host, {}, {"mac", "ip", "name"})
        mac = host.get("mac", "").lower()
        ip_text = host.get("ip", "")
        name = host.get("name", "")
        if not re.fullmatch(r"[0-9a-f]{2}(?::[0-9a-f]{2}){5}", mac):
            raise ContractError("default DHCP host MAC is malformed")
        try:
            host_ip = ipaddress.ip_address(ip_text)
        except ValueError as exc:
            raise ContractError("default DHCP host IP is malformed") from exc
        if host_ip not in subnet or not name or not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9.-]{0,62}", name):
            raise ContractError("default DHCP host identity is malformed")
        current = (mac, str(host_ip), name)
        if current == target:
            target_count += 1
        elif mac == EXPECTED_MAC or str(host_ip) == EXPECTED_GUEST_IP or name == DOMAIN_NAME:
            raise ContractError("default network contains a conflicting runner reservation")
        else:
            unrelated.append(current)
        if mac in seen_macs or str(host_ip) in seen_ips or name in seen_names:
            raise ContractError("default network contains duplicate DHCP host identity")
        seen_macs.add(mac)
        seen_ips.add(str(host_ip))
        seen_names.add(name)
    if target_count > 1:
        raise ContractError("default network contains duplicate runner reservations")

    if mode == "source":
        if ranges != [(EXPECTED_DHCP_START, EXPECTED_DHCP_END)] or unrelated or target_count != 1:
            raise ContractError("reviewed absent-network XML is not exact")

    mac_node = _optional_one(root, "mac")
    bridge_mac: str | None = None
    if mac_node is not None:
        _exact_attributes(mac_node, {}, {"address"})
        bridge_mac = mac_node.get("address")
        if bridge_mac is None or not re.fullmatch(r"[0-9a-f]{2}(?::[0-9a-f]{2}){5}", bridge_mac):
            raise ContractError("invalid derived bridge MAC")
    non_target = {
        "name": NETWORK_NAME,
        "bridge": NETWORK_BRIDGE,
        # Missing and explicitly derived bridge MACs are intentionally
        # distinct: either transition is concurrent non-target drift.
        "bridge_mac": bridge_mac,
        "gateway": f"{NETWORK_HOST_IP}/{NETWORK_PREFIX}",
        "ranges": sorted(ranges),
        "unrelated_hosts": sorted(unrelated),
    }
    return {
        "uuid": _text(uuid_node) if uuid_node is not None else None,
        "bridge_mac": bridge_mac,
        "reservation_present": target_count == 1,
        "non_target_sha256": hashlib.sha256(
            json.dumps(non_target, sort_keys=True, separators=(",", ":")).encode()
        ).hexdigest(),
    }


def add_default_network_reservation(text: str) -> str:
    """Return XML with exactly the owned reservation appended, preserving peers."""

    root = _parse_xml(text, "network")
    uuid_node = _optional_one(root, "uuid")
    expected_uuid = _text(uuid_node) if uuid_node is not None else None
    mode = "inactive" if expected_uuid is not None else "source"
    result = validate_network_xml(text, mode, expected_uuid)
    if result["reservation_present"]:
        raise ContractError("runner reservation already exists")
    ip_node = _one(root, "ip")
    dhcp = _one(ip_node, "dhcp")
    ET.SubElement(
        dhcp,
        "host",
        {"mac": EXPECTED_MAC, "name": DOMAIN_NAME, "ip": EXPECTED_GUEST_IP},
    )
    rendered = ET.tostring(root, encoding="unicode")
    validated = validate_network_xml(rendered, mode, expected_uuid)
    if not validated["reservation_present"]:
        raise ContractError("reservation append did not converge")
    return rendered


def reservation_update_plan(
    inactive_present: bool,
    live_present: bool,
    active: bool,
) -> tuple[bool, bool]:
    """Plan config/live reservation repair after any crash cut point."""

    if not active and live_present:
        raise ContractError("inactive network cannot have a live-only reservation")
    return (not inactive_present, active and not live_present)


def build_network_update_command(
    network_uuid: str,
    update_config: bool,
    update_live: bool,
) -> list[str]:
    """Build one UUID-bound additive reservation mutation."""

    if not _valid_uuid(network_uuid):
        raise ContractError("network update UUID is malformed")
    if not update_config and not update_live:
        raise ContractError("network update has no requested scope")
    host_xml = f"<host mac='{EXPECTED_MAC}' name='{DOMAIN_NAME}' ip='{EXPECTED_GUEST_IP}'/>"
    command = [
        "/usr/bin/virsh", "--connect", "qemu:///system", "net-update",
        network_uuid, "add-last", "ip-dhcp-host", host_xml,
        "--parent-index", "0",
    ]
    if update_config:
        command.append("--config")
    if update_live:
        command.append("--live")
    return command


def validate_default_network_leases(output: str) -> tuple[tuple[str, str, str], ...]:
    """Reject an active lease that conflicts with the runner's fixed identity."""

    leases: list[tuple[str, str, str]] = []
    for raw_line in output.splitlines():
        line = raw_line.strip()
        if not line or line.startswith("Expiry Time") or set(line) == {"-"}:
            continue
        columns = re.split(r"\s{2,}", line, maxsplit=5)
        if len(columns) != 6:
            raise ContractError("default network lease output is malformed")
        _expiry, mac, protocol, address, hostname, _client = columns
        mac = mac.lower()
        if not re.fullmatch(r"[0-9a-f]{2}(?::[0-9a-f]{2}){5}", mac):
            raise ContractError("default network lease MAC is malformed")
        if protocol not in {"ipv4", "ipv6"}:
            raise ContractError("default network lease protocol is malformed")
        try:
            leased_ip = str(ipaddress.ip_interface(address).ip)
        except ValueError as exc:
            raise ContractError("default network lease address is malformed") from exc
        hostname = "" if hostname == "-" else hostname
        current = (mac, leased_ip, hostname)
        target_lease = mac == EXPECTED_MAC and leased_ip == EXPECTED_GUEST_IP and hostname in {"", DOMAIN_NAME}
        if (mac == EXPECTED_MAC or leased_ip == EXPECTED_GUEST_IP or hostname == DOMAIN_NAME) and not target_lease:
            raise ContractError("active default-network lease conflicts with runner identity")
        leases.append(current)
    if len(leases) != len(set(leases)):
        raise ContractError("default network lease output contains duplicates")
    return tuple(leases)


def _memory_bytes(node: ET.Element) -> int:
    value_text = _text(node)
    if not value_text.isdigit():
        raise ContractError(f"{node.tag} must be an integer")
    factors = {"B": 1, "KiB": 1024, "MiB": 1024**2, "GiB": 1024**3}
    unit = node.get("unit", "KiB")
    if unit not in factors:
        raise ContractError(f"unsupported memory unit: {unit}")
    _exact_attributes(node, {}, {"unit"})
    return int(value_text) * factors[unit]


def _validate_empty_node(node: ET.Element) -> None:
    if list(node) or _text(node):
        raise ContractError(f"{node.tag} must be empty")


def _validate_derived_alias(node: ET.Element) -> None:
    _exact_attributes(node, {}, {"name"})
    _validate_empty_node(node)
    if not re.fullmatch(r"[A-Za-z][A-Za-z0-9_.-]{0,63}", node.get("name", "")):
        raise ContractError("derived alias is malformed")


def _validate_derived_address(node: ET.Element) -> None:
    address_type = node.get("type")
    if address_type == "pci":
        _exact_attributes(node, {"type": "pci"}, {"domain", "bus", "slot", "function", "multifunction"})
        for key in ("domain", "bus", "slot", "function"):
            value = node.get(key)
            if value is not None and re.fullmatch(r"0x[0-9a-f]{1,4}", value) is None:
                raise ContractError("derived PCI address is malformed")
        if node.get("multifunction") not in {None, "on", "off"}:
            raise ContractError("derived PCI multifunction policy is malformed")
    elif address_type == "drive":
        _exact_attributes(node, {"type": "drive"}, {"controller", "bus", "target", "unit"})
        for key in ("controller", "bus", "target", "unit"):
            value = node.get(key)
            if value is not None and not value.isdigit():
                raise ContractError("derived drive address is malformed")
    elif address_type == "isa":
        _exact_attributes(node, {"type": "isa"}, {"iobase", "irq"})
        if node.get("iobase") is not None and re.fullmatch(r"0x[0-9a-f]+", node.get("iobase", "")) is None:
            raise ContractError("derived ISA base address is malformed")
        if node.get("irq") is not None and not node.get("irq", "").isdigit():
            raise ContractError("derived ISA IRQ is malformed")
    else:
        raise ContractError("unreviewed derived address type")
    _validate_empty_node(node)


def _validate_optional_derived_identity(node: ET.Element) -> None:
    alias = _optional_one(node, "alias")
    if alias is not None:
        _validate_derived_alias(alias)
    address = _optional_one(node, "address")
    if address is not None:
        _validate_derived_address(address)


def _validate_disk(node: ET.Element, live: bool) -> tuple[str, str]:
    _exact_attributes(node, {"type": "file"}, {"device", "snapshot"})
    device = node.get("device")
    if device not in {"disk", "cdrom"}:
        raise ContractError("only the reviewed disk and seed CD-ROM are allowed")
    if node.get("snapshot") not in {None, "no"}:
        raise ContractError("domain disk snapshots are forbidden")
    _require_allowed_children(node, {"driver", "source", "target", "readonly", "alias", "address"})
    driver = _one(node, "driver")
    source = _one(node, "source")
    target = _one(node, "target")
    _exact_attributes(source, {}, {"file"})
    _validate_empty_node(driver)
    _validate_empty_node(source)
    _validate_empty_node(target)
    _validate_optional_derived_identity(node)
    if len(_children(node, "alias")) > 1 or len(_children(node, "address")) > 1:
        raise ContractError("duplicate derived disk identity")

    if device == "disk":
        _exact_attributes(driver, {"name": "qemu", "type": "qcow2", "cache": "none"})
        _exact_attributes(target, {"dev": "vda", "bus": "virtio"})
        if source.get("file") != EXPECTED_DISK or _children(node, "readonly"):
            raise ContractError("primary disk contract drift")
        return "disk", EXPECTED_DISK

    _exact_attributes(driver, {"name": "qemu", "type": "raw"})
    _exact_attributes(target, {"dev": "sda", "bus": "sata"})
    if source.get("file") != EXPECTED_SEED or len(_children(node, "readonly")) != 1:
        raise ContractError("seed CD-ROM contract drift")
    _exact_attributes(_children(node, "readonly")[0], {})
    _validate_empty_node(_children(node, "readonly")[0])
    return "seed", EXPECTED_SEED


def _validate_interface(node: ET.Element, mode: str) -> None:
    _exact_attributes(node, {"type": "network"})
    allowed = {"mac", "source", "model", "alias", "address"}
    if mode == "live":
        allowed |= {"target", "link"}
    _require_allowed_children(node, allowed)
    mac = _one(node, "mac")
    source = _one(node, "source")
    model = _one(node, "model")
    _exact_attributes(mac, {"address": EXPECTED_MAC})
    _exact_attributes(model, {"type": "virtio"})
    _validate_empty_node(mac)
    _validate_empty_node(model)
    if mode == "live":
        _exact_attributes(source, {"network": NETWORK_NAME}, {"bridge", "portid"})
        if source.get("bridge") not in {None, NETWORK_BRIDGE}:
            raise ContractError("live NIC derived bridge is not the reviewed bridge")
        port_id = source.get("portid")
        if port_id is not None and not _valid_uuid(port_id):
            raise ContractError("live NIC portid is malformed")
        target = _optional_one(node, "target")
        if target is not None:
            _exact_attributes(target, {}, {"dev"})
            if not re.fullmatch(r"vnet[0-9]+", target.get("dev", "")):
                raise ContractError("live NIC target is not libvirt-derived")
            _validate_empty_node(target)
        link = _optional_one(node, "link")
        if link is not None:
            _exact_attributes(link, {"state": "up"})
            _validate_empty_node(link)
    else:
        _exact_attributes(source, {"network": NETWORK_NAME})
    _validate_empty_node(source)
    _validate_optional_derived_identity(node)
    if len(_children(node, "alias")) > 1 or len(_children(node, "address")) > 1:
        raise ContractError("duplicate derived NIC identity")


def _validate_character_device(node: ET.Element, live: bool) -> None:
    """Forbid serial/console backends that can expose host paths or sockets."""

    _exact_attributes(node, {"type": "pty"}, {"tty"} if live else set())
    tty = node.get("tty")
    if tty is not None and re.fullmatch(r"/dev/pts/[0-9]+", tty) is None:
        raise ContractError(f"{node.tag} derived PTY path is malformed")
    allowed = {"target", "alias", "address"}
    if live:
        allowed.add("source")
    _require_allowed_children(node, allowed)
    if len(_children(node, "target")) != 1:
        raise ContractError(f"{node.tag} must have exactly one target")
    if len(_children(node, "alias")) > 1 or len(_children(node, "address")) > 1:
        raise ContractError(f"{node.tag} has duplicate derived identity")
    target = _children(node, "target")[0]
    expected = {"type": "isa-serial", "port": "0"} if node.tag == "serial" else {"type": "serial", "port": "0"}
    _exact_attributes(target, expected)
    if node.tag == "serial":
        _require_allowed_children(target, {"model"})
        if _text(target):
            raise ContractError("serial target contains unexpected text")
        model = _optional_one(target, "model")
        if model is not None:
            _exact_attributes(model, {"name": "isa-serial"})
            _validate_empty_node(model)
    else:
        _validate_empty_node(target)
    source = _optional_one(node, "source")
    if source is not None:
        _exact_attributes(source, {}, {"path"})
        if tty is None or source.get("path") != tty:
            raise ContractError(f"{node.tag} PTY source does not match its derived tty")
        _validate_empty_node(source)
    _validate_optional_derived_identity(node)


def _validate_guest_os(node: ET.Element) -> None:
    _exact_attributes(node, {})
    _require_allowed_children(node, {"type", "boot"})
    guest_type = _one(node, "type")
    if _text(guest_type) != "hvm":
        raise ContractError("domain guest type is not HVM")
    _exact_attributes(guest_type, {"arch": "x86_64", "machine": EXPECTED_MACHINE})
    if list(guest_type):
        raise ContractError("domain guest type contains unreviewed children")
    boots = _children(node, "boot")
    if len(boots) != 1:
        raise ContractError("domain must contain exactly one reviewed boot device")
    _exact_attributes(boots[0], {"dev": "hd"})
    _validate_empty_node(boots[0])


def _validate_features(node: ET.Element) -> None:
    _exact_attributes(node, {})
    _require_allowed_children(node, {"acpi", "apic"})
    if len(_children(node, "acpi")) != 1 or len(_children(node, "apic")) != 1:
        raise ContractError("domain must enable exactly ACPI and APIC")
    for child in node:
        _exact_attributes(child, {})
        _validate_empty_node(child)


def _validate_clock(node: ET.Element) -> None:
    _exact_attributes(node, {"offset": "utc"})
    _require_allowed_children(node, {"timer"})
    allowed = {
        "rtc": {"tickpolicy": "catchup"},
        "pit": {"tickpolicy": "delay"},
        "hpet": {"present": "no"},
    }
    seen: set[str] = set()
    for timer in _children(node, "timer"):
        name = timer.get("name", "")
        if name not in allowed or name in seen:
            raise ContractError("domain clock contains an unreviewed timer")
        _exact_attributes(timer, {"name": name, **allowed[name]})
        _validate_empty_node(timer)
        seen.add(name)
    if seen != set(allowed):
        raise ContractError("domain clock timer policy is incomplete")


def _validate_pm(node: ET.Element) -> None:
    _exact_attributes(node, {})
    _require_allowed_children(node, {"suspend-to-mem", "suspend-to-disk"})
    if {child.tag for child in node} != {"suspend-to-mem", "suspend-to-disk"} or len(node) != 2:
        raise ContractError("domain power-management policy is incomplete")
    for child in node:
        _exact_attributes(child, {"enabled": "no"})
        _validate_empty_node(child)


def _validate_security_label(node: ET.Element, model: str, expected_value: str | None) -> None:
    _exact_attributes(
        node,
        {"type": "dynamic", "model": model, "relabel": "yes"},
    )
    if expected_value is None:
        _require_allowed_children(node, set())
        _validate_empty_node(node)
        return
    _require_allowed_children(node, {"label", "imagelabel"})
    if len(_children(node, "label")) != 1 or len(_children(node, "imagelabel")) != 1 or len(node) != 2:
        raise ContractError("live AppArmor labels are incomplete or duplicated")
    for child in node:
        _exact_attributes(child, {})
        if list(child) or _text(child) != expected_value:
            raise ContractError(f"live {model} label is not bound to its reviewed identity")


def _validate_security_labels(
    root: ET.Element,
    mode: str,
    expected_uuid: str,
    expected_qemu_uid: int | None,
    expected_qemu_gid: int | None,
) -> None:
    labels = _children(root, "seclabel")
    if mode == "inactive":
        if len(labels) != 1 or labels[0].get("model") != "apparmor":
            raise ContractError("inactive domain must contain exactly one AppArmor label")
        _validate_security_label(labels[0], "apparmor", None)
        return
    if (
        not isinstance(expected_qemu_uid, int)
        or isinstance(expected_qemu_uid, bool)
        or expected_qemu_uid < 0
        or not isinstance(expected_qemu_gid, int)
        or isinstance(expected_qemu_gid, bool)
        or expected_qemu_gid < 0
    ):
        raise ContractError("live domain validation requires the preflight-attested QEMU uid/gid")
    if len(labels) != 2:
        raise ContractError("live domain must contain exactly the AppArmor and DAC security labels")
    by_model = {node.get("model", ""): node for node in labels}
    if len(by_model) != 2 or set(by_model) != {"apparmor", "dac"}:
        raise ContractError("live domain security-label stack is duplicated or unreviewed")
    _validate_security_label(
        by_model["apparmor"],
        "apparmor",
        f"libvirt-{expected_uuid}",
    )
    _validate_security_label(
        by_model["dac"],
        "dac",
        f"+{expected_qemu_uid}:+{expected_qemu_gid}",
    )


def _validate_controller(node: ET.Element) -> tuple[str, str]:
    controller_type = node.get("type", "")
    index = node.get("index", "")
    key = (controller_type, index)
    if key == ("pci", "0"):
        _exact_attributes(node, {"type": "pci", "index": "0", "model": "pcie-root"})
    elif key == ("sata", "0"):
        _exact_attributes(node, {"type": "sata", "index": "0"})
    else:
        raise ContractError("unreviewed domain controller")
    _require_allowed_children(node, set())
    _validate_empty_node(node)
    return key


def _validate_memballoon(node: ET.Element) -> None:
    _exact_attributes(node, {"model": "virtio"})
    _require_allowed_children(node, set())
    _validate_empty_node(node)


def _require_exact_child_tags(element: ET.Element, expected: Sequence[str]) -> None:
    actual = [child.tag for child in element]
    if actual != list(expected):
        raise ContractError(f"{element.tag} child topology is not the reviewed virt-install boundary")


def _parse_noble_virt_install_domain(text: str) -> ET.Element:
    """Validate exactly the reviewed Noble virtinst 4.1.0 generation shape."""

    try:
        root = ET.fromstring(text)
    except ET.ParseError as exc:
        raise ContractError(f"malformed virt-install XML: {exc}") from exc
    libosinfo_tag = f"{{{LIBOSINFO_NAMESPACE}}}libosinfo"
    libosinfo_os_tag = f"{{{LIBOSINFO_NAMESPACE}}}os"
    allowed_namespaced_tags = {libosinfo_tag, libosinfo_os_tag}
    for element in root.iter():
        if not isinstance(element.tag, str):
            raise ContractError("virt-install XML contains a non-element node")
        if element.tag.startswith("{") and element.tag not in allowed_namespaced_tags:
            raise ContractError("virt-install XML contains an unreviewed namespace")
        if not element.tag.startswith("{") and ":" in element.tag:
            raise ContractError("virt-install XML contains a malformed namespace")

    if root.tag != "domain":
        raise ContractError("virt-install XML root is not a domain")
    _exact_attributes(root, {"type": "kvm"})
    _require_exact_child_tags(
        root,
        (
            "name", "uuid", "metadata", "memory", "currentMemory", "vcpu",
            "os", "features", "cpu", "clock", "pm", "devices",
        ),
    )

    name = _one(root, "name")
    _exact_attributes(name, {})
    if list(name) or _text(name) != DOMAIN_NAME:
        raise ContractError("virt-install domain name drift")
    uuid_node = _one(root, "uuid")
    _exact_attributes(uuid_node, {})
    domain_uuid = _text(uuid_node)
    if list(uuid_node) or not _valid_uuid(domain_uuid):
        raise ContractError("virt-install domain UUID is malformed")

    metadata = _one(root, "metadata")
    _exact_attributes(metadata, {})
    _require_exact_child_tags(metadata, (libosinfo_tag,))
    libosinfo = list(metadata)[0]
    _exact_attributes(libosinfo, {})
    _require_exact_child_tags(libosinfo, (libosinfo_os_tag,))
    os_identity = list(libosinfo)[0]
    _exact_attributes(os_identity, {"id": EXPECTED_OSINFO_ID})
    _validate_empty_node(os_identity)

    expected_memory_kib = str(EXPECTED_MEMORY_BYTES // 1024)
    for tag in ("memory", "currentMemory"):
        memory = _one(root, tag)
        _exact_attributes(memory, {})
        if list(memory) or _text(memory) != expected_memory_kib:
            raise ContractError(f"virt-install {tag} drift")
    vcpu = _one(root, "vcpu")
    _exact_attributes(vcpu, {})
    if list(vcpu) or _text(vcpu) != "4":
        raise ContractError("virt-install vCPU drift")

    guest_os = _one(root, "os")
    _exact_attributes(guest_os, {})
    _require_exact_child_tags(guest_os, ("type", "boot"))
    guest_type = _one(guest_os, "type")
    _exact_attributes(
        guest_type,
        {"arch": "x86_64", "machine": VIRT_INSTALL_MACHINE},
    )
    if list(guest_type) or _text(guest_type) != "hvm":
        raise ContractError("virt-install guest type drift")
    boot = _one(guest_os, "boot")
    _exact_attributes(boot, {"dev": "hd"})
    _validate_empty_node(boot)

    features = _one(root, "features")
    _exact_attributes(features, {})
    _require_exact_child_tags(features, ("acpi", "apic"))
    for feature in features:
        _exact_attributes(feature, {})
        _validate_empty_node(feature)
    cpu = _one(root, "cpu")
    _exact_attributes(cpu, {"mode": "host-passthrough"})
    _validate_empty_node(cpu)
    _validate_clock(_one(root, "clock"))
    power_management = _one(root, "pm")
    _require_exact_child_tags(
        power_management,
        ("suspend-to-mem", "suspend-to-disk"),
    )
    _validate_pm(power_management)

    devices = _one(root, "devices")
    _exact_attributes(devices, {})
    _require_exact_child_tags(
        devices,
        (
            "emulator", "disk", "disk",
            *(["controller"] * (VIRT_INSTALL_PCIE_ROOT_PORTS + 2)),
            "interface", "console", "channel", "memballoon", "rng",
        ),
    )
    emulator = _one(devices, "emulator")
    _exact_attributes(emulator, {})
    if list(emulator) or _text(emulator) != "/usr/bin/qemu-system-x86_64":
        raise ContractError("virt-install emulator drift")

    disks = _children(devices, "disk")
    _exact_attributes(disks[0], {"type": "file", "device": "disk"})
    _require_exact_child_tags(disks[0], ("driver", "source", "target"))
    _exact_attributes(disks[1], {"type": "file", "device": "cdrom"})
    _require_exact_child_tags(disks[1], ("driver", "source", "target", "readonly"))
    if {_validate_disk(node, False)[0] for node in disks} != {"disk", "seed"}:
        raise ContractError("virt-install disk topology drift")

    controllers = _children(devices, "controller")
    _exact_attributes(
        controllers[0],
        {"type": "usb", "model": "qemu-xhci", "ports": "15"},
    )
    _validate_empty_node(controllers[0])
    _exact_attributes(controllers[1], {"type": "pci", "model": "pcie-root"})
    _validate_empty_node(controllers[1])
    for controller in controllers[2:]:
        _exact_attributes(
            controller,
            {"type": "pci", "model": "pcie-root-port"},
        )
        _validate_empty_node(controller)

    interface = _one(devices, "interface")
    _require_exact_child_tags(interface, ("source", "mac", "model"))
    _validate_interface(interface, "inactive")
    console = _one(devices, "console")
    _exact_attributes(console, {"type": "pty"})
    _validate_empty_node(console)
    channel = _one(devices, "channel")
    _exact_attributes(channel, {"type": "unix"})
    _require_exact_child_tags(channel, ("source", "target"))
    channel_source = _one(channel, "source")
    _exact_attributes(channel_source, {"mode": "bind"})
    _validate_empty_node(channel_source)
    channel_target = _one(channel, "target")
    _exact_attributes(
        channel_target,
        {"type": "virtio", "name": "org.qemu.guest_agent.0"},
    )
    _validate_empty_node(channel_target)
    _validate_memballoon(_one(devices, "memballoon"))
    rng = _one(devices, "rng")
    _exact_attributes(rng, {"model": "virtio"})
    _require_exact_child_tags(rng, ("backend",))
    backend = _one(rng, "backend")
    _exact_attributes(backend, {"model": "random"})
    if list(backend) or _text(backend) != "/dev/urandom":
        raise ContractError("virt-install RNG backend drift")
    return root


def _build_reviewed_domain(domain_uuid: str) -> ET.Element:
    """Construct the one strict persistent domain accepted after normalization."""

    if not _valid_uuid(domain_uuid):
        raise ContractError("reviewed domain UUID is malformed")
    root = ET.Element("domain", {"type": "kvm"})
    name = ET.SubElement(root, "name")
    name.text = DOMAIN_NAME
    uuid_node = ET.SubElement(root, "uuid")
    uuid_node.text = domain_uuid
    memory = ET.SubElement(root, "memory", {"unit": "KiB"})
    memory.text = str(EXPECTED_MEMORY_BYTES // 1024)
    current_memory = ET.SubElement(root, "currentMemory", {"unit": "KiB"})
    current_memory.text = str(EXPECTED_MEMORY_BYTES // 1024)
    vcpu = ET.SubElement(root, "vcpu", {"placement": "static", "current": "4"})
    vcpu.text = "4"
    ET.SubElement(
        root,
        "cpu",
        {"mode": "host-passthrough", "check": "none", "migratable": "on"},
    )
    guest_os = ET.SubElement(root, "os")
    guest_type = ET.SubElement(
        guest_os,
        "type",
        {"arch": "x86_64", "machine": EXPECTED_MACHINE},
    )
    guest_type.text = "hvm"
    ET.SubElement(guest_os, "boot", {"dev": "hd"})
    features = ET.SubElement(root, "features")
    ET.SubElement(features, "acpi")
    ET.SubElement(features, "apic")
    clock = ET.SubElement(root, "clock", {"offset": "utc"})
    ET.SubElement(clock, "timer", {"name": "rtc", "tickpolicy": "catchup"})
    ET.SubElement(clock, "timer", {"name": "pit", "tickpolicy": "delay"})
    ET.SubElement(clock, "timer", {"name": "hpet", "present": "no"})
    for tag, value in (
        ("on_poweroff", "destroy"),
        ("on_reboot", "restart"),
        ("on_crash", "destroy"),
    ):
        policy = ET.SubElement(root, tag)
        policy.text = value
    power_management = ET.SubElement(root, "pm")
    ET.SubElement(power_management, "suspend-to-mem", {"enabled": "no"})
    ET.SubElement(power_management, "suspend-to-disk", {"enabled": "no"})
    ET.SubElement(
        root,
        "seclabel",
        {"type": "dynamic", "model": "apparmor", "relabel": "yes"},
    )

    devices = ET.SubElement(root, "devices")
    emulator = ET.SubElement(devices, "emulator")
    emulator.text = "/usr/bin/qemu-system-x86_64"
    disk = ET.SubElement(devices, "disk", {"type": "file", "device": "disk"})
    ET.SubElement(
        disk,
        "driver",
        {"name": "qemu", "type": "qcow2", "cache": "none"},
    )
    ET.SubElement(disk, "source", {"file": EXPECTED_DISK})
    ET.SubElement(disk, "target", {"dev": "vda", "bus": "virtio"})
    seed = ET.SubElement(devices, "disk", {"type": "file", "device": "cdrom"})
    ET.SubElement(seed, "driver", {"name": "qemu", "type": "raw"})
    ET.SubElement(seed, "source", {"file": EXPECTED_SEED})
    ET.SubElement(seed, "target", {"dev": "sda", "bus": "sata"})
    ET.SubElement(seed, "readonly")
    ET.SubElement(
        devices,
        "controller",
        {"type": "pci", "index": "0", "model": "pcie-root"},
    )
    ET.SubElement(devices, "controller", {"type": "sata", "index": "0"})
    interface = ET.SubElement(devices, "interface", {"type": "network"})
    ET.SubElement(interface, "mac", {"address": EXPECTED_MAC})
    ET.SubElement(interface, "source", {"network": NETWORK_NAME})
    ET.SubElement(interface, "model", {"type": "virtio"})
    serial = ET.SubElement(devices, "serial", {"type": "pty"})
    ET.SubElement(serial, "target", {"type": "isa-serial", "port": "0"})
    console = ET.SubElement(devices, "console", {"type": "pty"})
    ET.SubElement(console, "target", {"type": "serial", "port": "0"})
    ET.SubElement(devices, "memballoon", {"model": "virtio"})
    return root


def _normalize_noble_virt_install_domain(text: str) -> ET.Element:
    generated = _parse_noble_virt_install_domain(text)
    domain_uuid = _text(_one(generated, "uuid"))
    normalized = _build_reviewed_domain(domain_uuid)
    validate_domain_xml(
        ET.tostring(normalized, encoding="unicode"),
        "inactive",
        domain_uuid,
    )
    return normalized


def validate_domain_xml(
    text: str,
    mode: str,
    expected_uuid: str,
    expected_qemu_uid: int | None = None,
    expected_qemu_gid: int | None = None,
) -> dict[str, Any]:
    """Validate exact persistent or live domain semantics."""

    if mode not in {"inactive", "live"}:
        raise ContractError(f"invalid domain validation mode: {mode}")
    if not _valid_uuid(expected_uuid):
        raise ContractError("expected domain UUID is malformed")
    root = _parse_xml(text, "domain")
    _exact_attributes(root, {"type": "kvm"}, {"id"} if mode == "live" else set())
    if "id" in root.attrib and not root.attrib["id"].isdigit():
        raise ContractError("live domain id must be numeric")
    allowed_root = {
        "name", "uuid", "memory", "currentMemory", "vcpu",
        "os", "features", "cpu", "clock", "on_poweroff", "on_reboot",
        "on_crash", "pm", "devices", "seclabel",
    }
    _require_allowed_children(root, allowed_root)
    name_node = _one(root, "name")
    _exact_attributes(name_node, {})
    if list(name_node) or _text(name_node) != DOMAIN_NAME:
        raise ContractError("domain name drift")
    uuid_node = _one(root, "uuid")
    _exact_attributes(uuid_node, {})
    if list(uuid_node):
        raise ContractError("domain UUID contains children")
    uuid_value = _text(uuid_node)
    if uuid_value != expected_uuid:
        raise ContractError("domain UUID changed")
    if _memory_bytes(_one(root, "memory")) != EXPECTED_MEMORY_BYTES:
        raise ContractError("domain maximum memory drift")
    current_memory = _one(root, "currentMemory")
    if _memory_bytes(current_memory) != EXPECTED_MEMORY_BYTES:
        raise ContractError("domain current memory is reduced")
    vcpu = _one(root, "vcpu")
    if _text(vcpu) != "4":
        raise ContractError("domain maximum vCPU count drift")
    _exact_attributes(vcpu, {"placement": "static", "current": "4"})
    if list(vcpu):
        raise ContractError("domain vCPU element contains children")
    cpu = _one(root, "cpu")
    _exact_attributes(cpu, {"mode": "host-passthrough", "check": "none", "migratable": "on"})
    if list(cpu):
        raise ContractError("unreviewed CPU topology/features are forbidden")
    _validate_guest_os(_one(root, "os"))
    _validate_features(_one(root, "features"))
    _validate_clock(_one(root, "clock"))
    for tag, expected in (
        ("on_poweroff", "destroy"),
        ("on_reboot", "restart"),
        ("on_crash", "destroy"),
    ):
        policy = _one(root, tag)
        _exact_attributes(policy, {})
        if list(policy) or _text(policy) != expected:
            raise ContractError(f"domain {tag} policy drift")
    _validate_pm(_one(root, "pm"))
    _validate_security_labels(
        root,
        mode,
        expected_uuid,
        expected_qemu_uid,
        expected_qemu_gid,
    )

    devices = _one(root, "devices")
    _exact_attributes(devices, {})
    forbidden = {
        "hostdev", "filesystem", "redirdev", "smartcard", "shmem", "graphics",
        "rng", "watchdog", "channel", "parallel", "audio", "vsock",
    }
    if any(child.tag in forbidden for child in devices):
        raise ContractError("domain exposes a forbidden host/public device")
    allowed_devices = {"emulator", "disk", "controller", "interface", "serial", "console", "memballoon"}
    _require_allowed_children(devices, allowed_devices)
    emulator = _one(devices, "emulator")
    _exact_attributes(emulator, {})
    if _text(emulator) not in {"/usr/bin/qemu-system-x86_64", "/usr/libexec/qemu-kvm"}:
        raise ContractError("domain emulator path is not reviewed")
    disks = _children(devices, "disk")
    interfaces = _children(devices, "interface")
    if len(disks) != 2 or len(interfaces) != 1:
        raise ContractError("domain must have exactly two disks and one private NIC")
    disk_kinds = {_validate_disk(node, mode == "live")[0] for node in disks}
    if disk_kinds != {"disk", "seed"}:
        raise ContractError("domain disk cardinality drift")
    _validate_interface(interfaces[0], mode)
    serial = _children(devices, "serial")
    console = _children(devices, "console")
    if len(serial) != 1 or len(console) != 1:
        raise ContractError("domain serial/console cardinality drift")
    for character in serial + console:
        _validate_character_device(character, mode == "live")
    controllers = [_validate_controller(node) for node in _children(devices, "controller")]
    if len(controllers) != len(set(controllers)) or not {("pci", "0"), ("sata", "0")} <= set(controllers):
        raise ContractError("domain controller topology drift")
    balloons = _children(devices, "memballoon")
    if len(balloons) != 1:
        raise ContractError("domain memory balloon cardinality drift")
    _validate_memballoon(balloons[0])
    return {
        "uuid": uuid_value,
        "semantic_sha256": hashlib.sha256(
            json.dumps(
                {
                    "name": DOMAIN_NAME,
                    "uuid": uuid_value,
                    "memory": EXPECTED_MEMORY_BYTES,
                    "vcpus": 4,
                    "disk": EXPECTED_DISK,
                    "seed": EXPECTED_SEED,
                    "network": NETWORK_NAME,
                    "mac": EXPECTED_MAC,
                },
                sort_keys=True,
                separators=(",", ":"),
            ).encode()
        ).hexdigest(),
    }


def _contains_encryption(value: Any, key_path: str = "") -> bool:
    if isinstance(value, dict):
        for key, child in value.items():
            lowered = key.lower()
            if ("encrypt" in lowered or "secret" in lowered) and child is not None and child is not False and child not in ("off", "none"):
                return True
            if _contains_encryption(child, f"{key_path}.{key}"):
                return True
    elif isinstance(value, list):
        return any(_contains_encryption(child, key_path) for child in value)
    return False


def parse_image_info(text: str, expected_filename: str) -> dict[str, Any]:
    """Strictly parse and validate qemu-img JSON for the persistent disk."""

    value = parse_json_strict(text)
    if not isinstance(value, dict):
        raise ContractError("qemu-img JSON must be one object")
    allowed = {
        "virtual-size", "filename", "cluster-size", "format", "actual-size", "dirty-flag",
        "snapshots", "format-specific", "encrypted", "backing-filename",
        "full-backing-filename", "backing-filename-format", "children", "corrupt",
    }
    unexpected = set(value) - allowed
    if unexpected:
        raise ContractError(f"unexpected qemu-img fields: {sorted(unexpected)}")
    if value.get("filename") != expected_filename:
        raise ContractError("qemu-img filename does not match the bound disk")
    if value.get("format") != "qcow2" or value.get("virtual-size") != EXPECTED_DISK_BYTES:
        raise ContractError("disk is not the reviewed 100 GiB qcow2")
    if value.get("dirty-flag") not in {None, False} or value.get("corrupt") not in {None, False}:
        raise ContractError("qcow2 reports dirty or corrupt state")
    if value.get("snapshots") is not None and value.get("snapshots") not in ((), []):
        raise ContractError("qcow2 internal snapshots are forbidden")
    for key in ("backing-filename", "full-backing-filename", "backing-filename-format", "children"):
        child = value.get(key)
        if child is not None and child is not False and child not in ("", (), []):
            raise ContractError("qcow2 backing/data children are forbidden")
    encrypted = value.get("encrypted")
    if (encrypted is not None and encrypted is not False) or _contains_encryption(value):
        raise ContractError("qcow2 encryption/secret state is forbidden")
    format_specific = value.get("format-specific")
    if format_specific is not None:
        if not isinstance(format_specific, dict) or format_specific.get("type") != "qcow2":
            raise ContractError("qemu-img format-specific state is malformed")
        data = format_specific.get("data", {})
        if not isinstance(data, dict):
            raise ContractError("qemu-img format-specific data is malformed")
        if data.get("data-file") not in {None, False, ""} or data.get("has-backing-file") not in {None, False}:
            raise ContractError("qcow2 external data/backing files are forbidden")
    return value


def validate_base_image_info(text: str, expected_filename: str) -> dict[str, Any]:
    """Require a self-contained, unencrypted qcow2 base before conversion."""

    value = parse_json_strict(text)
    if not isinstance(value, dict):
        raise ContractError("base-image qemu JSON must be one object")
    allowed = {
        "virtual-size", "filename", "cluster-size", "format", "actual-size", "dirty-flag",
        "snapshots", "format-specific", "encrypted", "backing-filename",
        "full-backing-filename", "backing-filename-format", "children", "corrupt",
    }
    if set(value) - allowed:
        raise ContractError("base image reports unexpected qemu-img fields")
    virtual_size = value.get("virtual-size")
    if (
        value.get("filename") != expected_filename
        or value.get("format") != "qcow2"
        or not isinstance(virtual_size, int)
        or isinstance(virtual_size, bool)
        or virtual_size <= 0
        or virtual_size > EXPECTED_DISK_BYTES
    ):
        raise ContractError("base image is not one bounded qcow2")
    if value.get("dirty-flag") not in {None, False} or value.get("corrupt") not in {None, False}:
        raise ContractError("base qcow2 reports dirty or corrupt state")
    snapshots = value.get("snapshots")
    if snapshots is not None and snapshots != [] and snapshots != ():
        raise ContractError("base qcow2 internal snapshots are forbidden")
    for key in ("backing-filename", "full-backing-filename", "backing-filename-format", "children"):
        child = value.get(key)
        if child is not None and child is not False and child not in ("", (), []):
            raise ContractError("base qcow2 backing/data children are forbidden")
    encrypted = value.get("encrypted")
    if (encrypted is not None and encrypted is not False) or _contains_encryption(value):
        raise ContractError("base qcow2 encryption/secret state is forbidden")
    format_specific = value.get("format-specific")
    if format_specific is not None:
        if not isinstance(format_specific, dict) or format_specific.get("type") != "qcow2":
            raise ContractError("base qemu-img format-specific state is malformed")
        data = format_specific.get("data", {})
        if not isinstance(data, dict):
            raise ContractError("base qemu-img format-specific data is malformed")
        if data.get("data-file") not in {None, False, ""} or data.get("has-backing-file") not in {None, False}:
            raise ContractError("base qcow2 external data/backing file is forbidden")
    return value


def validate_ssh_key_report(key_text: str, report: str) -> dict[str, Any]:
    """Bind a successful ssh-keygen report to the reviewed key policy."""

    if "\n" in key_text.rstrip("\n") or "\r" in key_text or len(key_text) > 16384:
        raise ContractError("SSH key must be one bounded line")
    parts = key_text.strip().split()
    if len(parts) not in {2, 3}:
        raise ContractError("SSH key line is malformed")
    algorithm_map = {"ssh-ed25519": "ED25519", "ssh-rsa": "RSA"}
    expected_algorithm = algorithm_map.get(parts[0])
    if expected_algorithm is None:
        raise ContractError("SSH key algorithm is not allowed")
    try:
        base64.b64decode(parts[1] + "=" * (-len(parts[1]) % 4), validate=True)
    except (ValueError, binascii.Error) as exc:
        raise ContractError("SSH key payload is malformed") from exc
    match = re.fullmatch(r"([0-9]+) (SHA256:[A-Za-z0-9+/]+) .+ \((ED25519|RSA)\)", report.strip())
    if match is None or match.group(3) != expected_algorithm:
        raise ContractError("ssh-keygen did not validate the supplied key")
    bits = int(match.group(1))
    minimum = {"ED25519": 256, "RSA": 3072}[expected_algorithm]
    if bits < minimum or (expected_algorithm == "ED25519" and bits != 256):
        raise ContractError("SSH key strength is below policy")
    return {"algorithm": expected_algorithm, "bits": bits, "fingerprint": match.group(2)}


def _canonical_json(value: Mapping[str, Any]) -> bytes:
    return (json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=True) + "\n").encode()


def seal_transaction_manifest(payload: Mapping[str, Any]) -> dict[str, Any]:
    """Seal a non-secret transaction document with canonical SHA-256 integrity."""

    if "integrity_sha256" in payload:
        raise ContractError("transaction payload must not pre-populate its integrity field")
    result = dict(payload)
    result["integrity_sha256"] = hashlib.sha256(_canonical_json(result)).hexdigest()
    return result


def verify_transaction_manifest(document: Mapping[str, Any]) -> dict[str, Any]:
    """Verify and return a transaction payload without its integrity field."""

    if not isinstance(document, Mapping):
        raise ContractError("transaction manifest must be one object")
    payload = dict(document)
    digest = payload.pop("integrity_sha256", None)
    if not isinstance(digest, str) or not re.fullmatch(r"[0-9a-f]{64}", digest):
        raise ContractError("transaction manifest integrity field is missing")
    expected = hashlib.sha256(_canonical_json(payload)).hexdigest()
    if not hmac.compare_digest(digest, expected):
        raise ContractError("transaction manifest integrity mismatch")
    return payload


def reconcile_transaction_state(
    phase: str,
    disk_stage: str,
    disk_final: str,
    seed_stage: str,
    seed_final: str,
    domain_exists: bool,
) -> str:
    """Select the only safe next action for an owned transaction cut point."""

    states = {disk_stage, disk_final, seed_stage, seed_final}
    if not states <= {"missing", "owned"}:
        raise ContractError("unknown transaction artifact must remain untouched")
    if disk_stage == "owned" and disk_final == "missing" and seed_stage == "owned" and seed_final == "missing":
        return "publish-disk"
    if disk_stage == "missing" and disk_final == "owned" and seed_stage == "owned" and seed_final == "missing":
        return "publish-seed"
    if disk_stage == "missing" and disk_final == "owned" and seed_stage == "missing" and seed_final == "owned":
        if not domain_exists:
            return "define-domain"
        if phase in {"defining-domain", "configuring-domain"}:
            return "configure-domain"
        return "verify-complete"
    raise ContractError("transaction artifact combination is not safely resumable")


@dataclasses.dataclass(frozen=True)
class FileIdentity:
    """Stable file identity and policy fields."""

    device: int
    inode: int
    size: int
    mode: int
    uid: int
    gid: int
    nlink: int
    sha256: str | None = None

    @classmethod
    def from_stat(cls, info: os.stat_result, digest: str | None = None) -> "FileIdentity":
        return cls(info.st_dev, info.st_ino, info.st_size, stat.S_IMODE(info.st_mode), info.st_uid, info.st_gid, info.st_nlink, digest)


def _require_linux_root() -> None:
    if sys.platform != "linux" or not hasattr(os, "geteuid") or os.geteuid() != 0 or os.getuid() != 0:
        raise ContractError("trusted runner provisioning requires real Linux root")


def _attest_ancestor_chain(path: Path) -> None:
    absolute = path.absolute()
    cursor = Path(absolute.anchor)
    for component in absolute.parts[1:-1]:
        cursor /= component
        info = os.lstat(cursor)
        if stat.S_ISLNK(info.st_mode):
            raise ContractError(f"trusted ancestor is a symlink: {cursor}")
        if not stat.S_ISDIR(info.st_mode) or info.st_uid != 0 or stat.S_IMODE(info.st_mode) & 0o022:
            raise ContractError(f"trusted ancestor is not root-owned/non-writable: {cursor}")


def attest_trusted_file(path: Path, *, immutable: bool, executable: bool = False) -> FileIdentity:
    """Attest one root-owned, single-link, no-follow file and its ancestors."""

    _attest_ancestor_chain(path)
    info = os.lstat(path)
    if stat.S_ISLNK(info.st_mode) or not stat.S_ISREG(info.st_mode):
        raise ContractError(f"trusted source is not one regular no-follow file: {path}")
    mode = stat.S_IMODE(info.st_mode)
    if info.st_uid != 0 or info.st_nlink != 1 or mode & 0o022:
        raise ContractError(f"trusted source ownership/link/mode is unsafe: {path}")
    if immutable and mode & 0o200:
        raise ContractError(f"reviewed source must not be owner-writable: {path}")
    if executable and mode & 0o111 == 0:
        raise ContractError(f"trusted executable has no execute bit: {path}")
    return FileIdentity.from_stat(info)


def attest_trusted_executable(path: Path) -> FileIdentity:
    """Attest a fixed OS executable, allowing only a safe root-owned symlink chain."""

    _attest_ancestor_chain(path)
    link_info = os.lstat(path)
    if stat.S_ISLNK(link_info.st_mode):
        if link_info.st_uid != 0 or stat.S_IMODE(link_info.st_mode) & 0o022:
            raise ContractError(f"trusted executable symlink is mutable: {path}")
        try:
            resolved = path.resolve(strict=True)
        except OSError as exc:
            raise ContractError(f"trusted executable symlink is broken: {path}") from exc
    else:
        resolved = path
    return attest_trusted_file(resolved, immutable=False, executable=True)


def open_verified_source(
    path: Path,
    *,
    expected_sha256: str | None,
    immutable: bool,
    maximum_bytes: int | None = None,
) -> tuple[int, FileIdentity, bytes | None]:
    """Open once with O_NOFOLLOW, hash that descriptor, and retain it for consumption."""

    attest_trusted_file(path, immutable=immutable)
    descriptor = os.open(path, os.O_RDONLY | os.O_CLOEXEC | os.O_NOFOLLOW)
    try:
        before = os.fstat(descriptor)
        digest = hashlib.sha256()
        captured: bytearray | None = bytearray() if maximum_bytes is not None else None
        while True:
            chunk = os.read(descriptor, 1024 * 1024)
            if not chunk:
                break
            digest.update(chunk)
            if captured is not None:
                captured.extend(chunk)
                if len(captured) > maximum_bytes:
                    raise ContractError(f"trusted source exceeds its size limit: {path}")
        after = os.fstat(descriptor)
        if (before.st_dev, before.st_ino, before.st_size, before.st_mode, before.st_nlink) != (
            after.st_dev, after.st_ino, after.st_size, after.st_mode, after.st_nlink
        ):
            raise ContractError(f"trusted source changed while hashing: {path}")
        actual = digest.hexdigest()
        if expected_sha256 is not None and not hmac.compare_digest(actual, expected_sha256):
            raise ContractError(f"trusted source digest mismatch: {path}")
        os.lseek(descriptor, 0, os.SEEK_SET)
        return descriptor, FileIdentity.from_stat(after, actual), bytes(captured) if captured is not None else None
    except BaseException:
        os.close(descriptor)
        raise


class CommandRunner:
    """Execute fixed absolute tools with per-phase TERM/KILL deadlines."""

    OUTPUT_LIMIT_BYTES: Final = 1024 * 1024

    def __init__(self, deadlines: Mapping[str, int]) -> None:
        self.deadlines = dict(deadlines)
        self.environment = {"LC_ALL": "C", "LANG": "C", "PATH": "/usr/sbin:/usr/bin:/sbin:/bin"}
        self.current: subprocess.Popen[Any] | None = None
        self._spawn_in_progress = False
        self._pending_signal: int | None = None
        # Only the root-gated actual-wrapper regression supplies this hook.
        # Normal provisioning publishes immediately after Popen returns.
        self._spawn_publication_observer: Callable[[subprocess.Popen[Any]], None] | None = None

    @staticmethod
    def _wait_for_process_group_exit(
        process: subprocess.Popen[Any],
        process_group: int,
        deadline: float,
    ) -> bool:
        """Reap the leader and prove one captured process group is absent."""

        while True:
            process.poll()
            try:
                os.killpg(process_group, 0)
            except ProcessLookupError:
                return True
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                return False
            time.sleep(min(0.05, remaining))

    def _terminate_process_group(self, process: subprocess.Popen[Any]) -> None:
        """Boundedly TERM/KILL and prove the captured descendant group is gone."""

        process_group = process.pid
        if not isinstance(process_group, int) or isinstance(process_group, bool) or process_group <= 0:
            raise ContractError("external process group identity is malformed")
        try:
            os.killpg(process_group, signal.SIGTERM)
        except ProcessLookupError:
            process.poll()
            return
        grace = max(0, self.deadlines["kill_after_seconds"])
        if self._wait_for_process_group_exit(process, process_group, time.monotonic() + grace):
            return
        try:
            os.killpg(process_group, signal.SIGKILL)
        except ProcessLookupError:
            process.poll()
            return
        # SIGKILL delivery is not termination proof. Use a fresh, separate
        # bounded deadline and stop permanently on the first ESRCH so a later
        # numeric PGID reuse can never receive another signal from this call.
        if self._wait_for_process_group_exit(process, process_group, time.monotonic() + grace):
            return
        raise ContractError("external process group survived SIGKILL")

    def run(
        self,
        argv: Sequence[str],
        *,
        phase: str = "query",
        input_text: str | None = None,
        pass_fds: Sequence[int] = (),
        accepted: set[int] | None = None,
    ) -> subprocess.CompletedProcess[str]:
        if not argv or not argv[0].startswith("/"):
            raise ContractError("external command must use one fixed absolute executable")
        timeout = self.deadlines[f"{phase}_seconds"]
        input_bytes = input_text.encode("utf-8") if input_text is not None else b""
        if len(input_bytes) > self.OUTPUT_LIMIT_BYTES:
            raise ContractError("external command input exceeded its bound")
        process: subprocess.Popen[bytes] | None = None
        selector: selectors.BaseSelector | None = None
        stdout_chunks: list[bytes] = []
        stderr_chunks: list[bytes] = []
        total_output = 0
        deadline = time.monotonic() + timeout
        try:
            self._spawn_in_progress = True
            self._pending_signal = None
            try:
                process = subprocess.Popen(
                    list(argv),
                    stdin=subprocess.PIPE if input_text is not None else subprocess.DEVNULL,
                    stdout=subprocess.PIPE,
                    stderr=subprocess.PIPE,
                    env=self.environment,
                    close_fds=True,
                    pass_fds=tuple(pass_fds),
                    start_new_session=True,
                )
                if self._spawn_publication_observer is not None:
                    self._spawn_publication_observer(process)
                self.current = process
            except BaseException:
                if process is not None:
                    self._terminate_process_group(process)
                raise
            finally:
                self._spawn_in_progress = False

            pending_signal = self._pending_signal
            self._pending_signal = None
            if pending_signal is not None:
                self._terminate_process_group(process)
                raise CommandInterrupted(pending_signal, process.pid)

            selector = selectors.DefaultSelector()
            assert process.stdout is not None and process.stderr is not None
            os.set_blocking(process.stdout.fileno(), False)
            os.set_blocking(process.stderr.fileno(), False)
            selector.register(process.stdout, selectors.EVENT_READ, (stdout_chunks, "stdout"))
            selector.register(process.stderr, selectors.EVENT_READ, (stderr_chunks, "stderr"))
            input_offset = 0
            if process.stdin is not None:
                os.set_blocking(process.stdin.fileno(), False)
                selector.register(process.stdin, selectors.EVENT_WRITE, None)

            while selector.get_map():
                remaining = deadline - time.monotonic()
                if remaining <= 0:
                    self._terminate_process_group(process)
                    raise ContractError(f"external phase timed out: {argv[0]}")
                events = selector.select(min(remaining, 0.25))
                if not events and process.poll() is not None:
                    # A final nonblocking pass obtains EOF from both pipes.
                    events = selector.select(0)
                for key, mask in events:
                    stream = key.fileobj
                    if key.data is None:
                        if not mask & selectors.EVENT_WRITE:
                            continue
                        if input_offset < len(input_bytes):
                            try:
                                input_offset += os.write(stream.fileno(), input_bytes[input_offset:input_offset + 65536])
                            except BlockingIOError:
                                continue
                            except BrokenPipeError:
                                input_offset = len(input_bytes)
                        if input_offset >= len(input_bytes):
                            selector.unregister(stream)
                            stream.close()
                        continue
                    chunks, _label = key.data
                    try:
                        chunk = os.read(stream.fileno(), 65536)
                    except BlockingIOError:
                        continue
                    if not chunk:
                        selector.unregister(stream)
                        stream.close()
                        continue
                    total_output += len(chunk)
                    if total_output > self.OUTPUT_LIMIT_BYTES:
                        self._terminate_process_group(process)
                        raise ContractError(f"external command output exceeded its bound: {argv[0]}")
                    chunks.append(chunk)

            remaining = deadline - time.monotonic()
            if remaining <= 0:
                self._terminate_process_group(process)
                raise ContractError(f"external phase timed out: {argv[0]}")
            try:
                process.wait(timeout=remaining)
            except subprocess.TimeoutExpired as exc:
                self._terminate_process_group(process)
                raise ContractError(f"external phase timed out: {argv[0]}") from exc
        finally:
            self._spawn_in_progress = False
            self._pending_signal = None
            if selector is not None:
                selector.close()
            if process is not None:
                for stream in (process.stdin, process.stdout, process.stderr):
                    if stream is not None and not stream.closed:
                        stream.close()
            if self.current is process:
                self.current = None
        assert process is not None
        try:
            stdout = b"".join(stdout_chunks).decode("utf-8", "strict")
            stderr = b"".join(stderr_chunks).decode("utf-8", "strict")
        except UnicodeDecodeError as exc:
            raise ContractError(f"external command emitted non-UTF-8 output: {argv[0]}") from exc
        allowed = accepted if accepted is not None else {0}
        completed = subprocess.CompletedProcess(list(argv), process.returncode, stdout, stderr)
        if completed.returncode not in allowed:
            raise ContractError(
                f"external command failed ({completed.returncode}): {argv[0]}: {stderr.strip()}"
            )
        return completed

    def terminate_current(self, signum: int = signal.SIGTERM) -> bool:
        if self.current is not None:
            self._terminate_process_group(self.current)
            return True
        if self._spawn_in_progress:
            if self._pending_signal is None:
                self._pending_signal = int(signum)
            return False
        return True


def _renameat2_noreplace(source: Path, destination: Path) -> None:
    """Perform only the Linux no-clobber namespace mutation."""
    if sys.platform != "linux":
        raise ContractError("atomic no-replace publication requires Linux renameat2")
    libc = ctypes.CDLL(None, use_errno=True)
    function = getattr(libc, "renameat2", None)
    if function is None:
        raise ContractError("libc does not expose renameat2")
    function.argtypes = [ctypes.c_int, ctypes.c_char_p, ctypes.c_int, ctypes.c_char_p, ctypes.c_uint]
    function.restype = ctypes.c_int
    result = function(
        AT_FDCWD,
        os.fsencode(source),
        AT_FDCWD,
        os.fsencode(destination),
        RENAME_NOREPLACE,
    )
    if result != 0:
        error = ctypes.get_errno()
        raise ContractError(f"atomic no-replace publication failed: {os.strerror(error)}")


def rename_noreplace(
    source: Path,
    destination: Path,
    recorded_identity: Mapping[str, Any],
    publication_checkpoint: Callable[[str], None] | None = None,
) -> None:
    """Durably publish a recorded stage inode without replacing any path.

    The stage data and metadata are durable before the namespace mutation.
    A checkpoint callback exists only for the root-gated crash matrix; normal
    provisioning never supplies one.
    """

    if publication_checkpoint is None:
        publication_checkpoint = lambda _event: None
    descriptor = os.open(source, os.O_RDONLY | os.O_CLOEXEC | os.O_NOFOLLOW)
    try:
        before = os.fstat(descriptor)
        if not stat.S_ISREG(before.st_mode) or before.st_nlink != 1:
            raise ContractError("publication stage is not one regular single-link inode")
        observed = FileIdentity.from_stat(before)
        _require_recorded_identity("publication stage", recorded_identity, observed)
        publication_checkpoint("before-stage-fsync")
        os.fsync(descriptor)
        after_fsync = os.fstat(descriptor)
        _require_recorded_identity(
            "publication stage after fsync",
            recorded_identity,
            FileIdentity.from_stat(after_fsync),
        )
        publication_checkpoint("stage-fsynced")
        publication_checkpoint("before-stage-directory-fsync")
        _fsync_directory(source.parent)
        publication_checkpoint("stage-directory-fsynced")
        publication_checkpoint("before-rename")
        _renameat2_noreplace(source, destination)
        publication_checkpoint("renamed")
        after_rename = os.fstat(descriptor)
        _require_recorded_identity(
            "published inode",
            recorded_identity,
            FileIdentity.from_stat(after_rename),
        )
        destination_info = os.lstat(destination)
        if stat.S_ISLNK(destination_info.st_mode) or (
            destination_info.st_dev,
            destination_info.st_ino,
        ) != (after_rename.st_dev, after_rename.st_ino):
            raise ContractError("published pathname is not the fsynced stage inode")
        publication_checkpoint("before-destination-directory-fsync")
        _fsync_directory(destination.parent)
        publication_checkpoint("destination-directory-fsynced")
    finally:
        os.close(descriptor)


class RootLock:
    """A serialized root-only provisioning lock."""

    def __init__(self, directory: Path, filename: str = "provision.lock") -> None:
        self.directory = directory
        self.path = directory / filename
        self.descriptor: int | None = None

    def __enter__(self) -> "RootLock":
        if fcntl is None:
            raise ContractError("root provisioning lock requires Linux fcntl")
        ensure_root_private_directory(self.directory)
        self.descriptor = os.open(self.path, os.O_RDWR | os.O_CREAT | os.O_CLOEXEC | os.O_NOFOLLOW, 0o600)
        os.fchmod(self.descriptor, 0o600)
        lock_info = os.fstat(self.descriptor)
        if (
            not stat.S_ISREG(lock_info.st_mode)
            or lock_info.st_uid != 0
            or lock_info.st_nlink != 1
            or stat.S_IMODE(lock_info.st_mode) != 0o600
        ):
            os.close(self.descriptor)
            self.descriptor = None
            raise ContractError("provisioning lock file identity is unsafe")
        try:
            fcntl.flock(self.descriptor, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError as exc:
            raise ContractError("another runner provisioning transaction holds the lock") from exc
        return self

    def __exit__(self, exc_type: object, exc: object, traceback: object) -> None:
        if self.descriptor is not None:
            os.close(self.descriptor)
            self.descriptor = None


def ensure_root_private_directory(path: Path) -> None:
    """Create or attest one root-owned 0700 directory without following links."""

    _attest_ancestor_chain(path)
    try:
        info = os.lstat(path)
    except FileNotFoundError:
        os.mkdir(path, 0o700)
        info = os.lstat(path)
    if (
        stat.S_ISLNK(info.st_mode)
        or not stat.S_ISDIR(info.st_mode)
        or info.st_uid != 0
        or stat.S_IMODE(info.st_mode) != 0o700
    ):
        raise ContractError(f"private state directory is not root-owned 0700: {path}")


def _write_all(descriptor: int, data: bytes) -> None:
    """Write every byte or fail; ``os.write`` may legally be short."""

    view = memoryview(data)
    offset = 0
    while offset < len(view):
        written = os.write(descriptor, view[offset:])
        if written <= 0:
            raise ContractError("short write while publishing trusted state")
        offset += written


def _write_or_verify_immutable(path: Path, data: bytes, mode: int) -> None:
    """Create one immutable transaction input or verify the exact prior bytes."""

    digest = hashlib.sha256(data).hexdigest()
    try:
        descriptor = os.open(
            path,
            os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_CLOEXEC | os.O_NOFOLLOW,
            mode,
        )
    except FileExistsError:
        descriptor, identity, content = open_verified_source(
            path,
            expected_sha256=digest,
            immutable=True,
            maximum_bytes=max(1, len(data)),
        )
        os.close(descriptor)
        if identity.mode != mode or content != data:
            raise ContractError(f"immutable transaction input changed: {path}")
        return
    try:
        _write_all(descriptor, data)
        os.fchmod(descriptor, mode)
        os.fsync(descriptor)
    finally:
        os.close(descriptor)
    directory_descriptor = os.open(path.parent, os.O_RDONLY | os.O_DIRECTORY | os.O_CLOEXEC)
    try:
        os.fsync(directory_descriptor)
    finally:
        os.close(directory_descriptor)


def _atomic_write_manifest(path: Path, payload: Mapping[str, Any]) -> None:
    try:
        existing = os.lstat(path)
    except FileNotFoundError:
        existing = None
    if existing is not None and (
        stat.S_ISLNK(existing.st_mode)
        or not stat.S_ISREG(existing.st_mode)
        or existing.st_uid != 0
        or existing.st_nlink != 1
        or stat.S_IMODE(existing.st_mode) != 0o600
    ):
        raise ContractError("transaction manifest destination is unsafe")
    sealed = seal_transaction_manifest(payload)
    data = _canonical_json(sealed)
    temporary = path.with_name(f".{path.name}.{uuid.uuid4().hex}.tmp")
    descriptor = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_CLOEXEC | os.O_NOFOLLOW, 0o600)
    published = False
    try:
        try:
            _write_all(descriptor, data)
            os.fchmod(descriptor, 0o600)
            os.fsync(descriptor)
        finally:
            os.close(descriptor)
        os.replace(temporary, path)
        published = True
        directory_fd = os.open(path.parent, os.O_RDONLY | os.O_DIRECTORY | os.O_CLOEXEC)
        try:
            os.fsync(directory_fd)
        finally:
            os.close(directory_fd)
    finally:
        if not published:
            try:
                os.unlink(temporary)
            except FileNotFoundError:
                pass


def _load_contract(path: Path, expected_sha256: str) -> dict[str, Any]:
    descriptor, _, content = open_verified_source(path, expected_sha256=expected_sha256, immutable=True, maximum_bytes=65536)
    os.close(descriptor)
    assert content is not None
    value = parse_json_strict(content.decode("utf-8"))
    if not isinstance(value, dict) or value.get("version") != 1:
        raise ContractError("reviewed runner contract manifest is malformed")
    domain = value.get("domain")
    if not isinstance(domain, dict) or domain.get("osinfo") != EXPECTED_OSINFO:
        raise ContractError("runner contract does not pin the reviewed Ubuntu OS identity")
    deadlines = value.get("deadlines")
    deadline_names = {
        "total_seconds",
        "kill_after_seconds",
        "outer_kill_after_seconds",
        "query_seconds",
        "mutation_seconds",
        "image_seconds",
    }
    if not isinstance(deadlines, dict) or set(deadlines) != deadline_names:
        raise ContractError("runner contract deadline topology is malformed")
    if any(
        not isinstance(deadlines[name], int)
        or isinstance(deadlines[name], bool)
        or deadlines[name] <= 0
        for name in deadline_names
    ):
        raise ContractError("runner contract deadlines must be positive integers")
    inner_cleanup = deadlines["kill_after_seconds"] * 2
    outer_cleanup = deadlines["outer_kill_after_seconds"]
    if outer_cleanup < 15 or outer_cleanup < inner_cleanup + 5:
        raise ContractError("outer watchdog cannot cover both cleanup proofs and margin")
    return value


def _parse_arguments(argv: Sequence[str]) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    subparsers = parser.add_subparsers(dest="command", required=True)
    provision = subparsers.add_parser("provision")
    for name in ("contract", "provisioner", "helper", "network", "meta-data", "user-data-template", "base-image", "ssh-key"):
        provision.add_argument(f"--{name}", required=True)
    provision.add_argument("--contract-sha256", required=True)
    provision.add_argument("--helper-sha256", required=True)
    provision.add_argument("--base-image-sha256", required=True)
    self_test = subparsers.add_parser("self-test-linux")
    for name in ("contract", "provisioner", "network", "meta-data", "user-data-template"):
        self_test.add_argument(f"--{name}", required=True)
    wrapper_test = subparsers.add_parser("self-test-wrapper-timeout")
    for name in (
        "contract", "provisioner", "helper", "network", "meta-data",
        "user-data-template", "base-image", "ssh-key",
    ):
        wrapper_test.add_argument(f"--{name}", required=True)
    wrapper_test.add_argument("--contract-sha256", required=True)
    wrapper_test.add_argument("--helper-sha256", required=True)
    wrapper_test.add_argument("--base-image-sha256", required=True)
    wrapper_spawn_test = subparsers.add_parser("self-test-wrapper-spawn-boundary")
    for name in (
        "contract", "provisioner", "helper", "network", "meta-data",
        "user-data-template", "base-image", "ssh-key",
    ):
        wrapper_spawn_test.add_argument(f"--{name}", required=True)
    wrapper_spawn_test.add_argument("--contract-sha256", required=True)
    wrapper_spawn_test.add_argument("--helper-sha256", required=True)
    wrapper_spawn_test.add_argument("--base-image-sha256", required=True)
    return parser.parse_args(argv)


def _self_test_linux(arguments: argparse.Namespace) -> None:
    _require_linux_root()
    with tempfile.TemporaryDirectory(prefix="codestead-runner-self-test-", dir="/root") as temporary_text:
        temporary = Path(temporary_text)
        os.chmod(temporary, 0o700)
        for index, raw_path in enumerate(
            (
                arguments.contract,
                arguments.provisioner,
                arguments.network,
                arguments.meta_data,
                arguments.user_data_template,
            )
        ):
            source_path = Path(raw_path)
            source_descriptor = os.open(source_path, os.O_RDONLY | os.O_CLOEXEC | os.O_NOFOLLOW)
            try:
                source_info = os.fstat(source_descriptor)
                if not stat.S_ISREG(source_info.st_mode) or source_info.st_size > 2 * 1024 * 1024:
                    raise ContractError("Linux self-test input is not one bounded regular file")
                chunks: list[bytes] = []
                while True:
                    chunk = os.read(source_descriptor, 65536)
                    if not chunk:
                        break
                    chunks.append(chunk)
            finally:
                os.close(source_descriptor)
            staged = temporary / f"reviewed-source-{index}"
            _write_or_verify_immutable(staged, b"".join(chunks), 0o400)
            attest_trusted_file(staged, immutable=True)
        source = temporary / "source"
        destination = temporary / "destination"
        source.write_bytes(b"owned-publication")
        os.chmod(source, 0o600)
        source_identity = dataclasses.asdict(FileIdentity.from_stat(os.lstat(source)))
        rename_noreplace(source, destination, source_identity)
        if source.exists() or destination.read_bytes() != b"owned-publication":
            raise ContractError("renameat2 publication self-test failed")
        collision = temporary / "collision"
        collision.write_bytes(b"unknown")
        second = temporary / "second"
        second.write_bytes(b"owned")
        os.chmod(second, 0o600)
        second_identity = dataclasses.asdict(FileIdentity.from_stat(os.lstat(second)))
        try:
            rename_noreplace(second, collision, second_identity)
        except ContractError:
            pass
        else:
            raise ContractError("renameat2 overwrote an existing destination")
        if collision.read_bytes() != b"unknown" or second.read_bytes() != b"owned":
            raise ContractError("renameat2 collision altered an artifact")
        publication_events = (
            "before-stage-fsync",
            "stage-fsynced",
            "before-stage-directory-fsync",
            "stage-directory-fsynced",
            "before-rename",
            "renamed",
            "before-destination-directory-fsync",
            "destination-directory-fsynced",
        )
        for artifact in ("disk", "seed"):
            for event in publication_events:
                stage = temporary / f"{artifact}-{event}.stage"
                final = temporary / f"{artifact}-{event}.final"
                stage.write_bytes(f"{artifact}:{event}".encode())
                os.chmod(stage, 0o600)
                identity = dataclasses.asdict(FileIdentity.from_stat(os.lstat(stage)))

                def crash_at(observed_event: str, *, wanted: str = event) -> None:
                    if observed_event == wanted:
                        raise ContractError(f"simulated power cut at {wanted}")

                try:
                    rename_noreplace(stage, final, identity, crash_at)
                except ContractError as exc:
                    if "simulated power cut" not in str(exc):
                        raise
                else:
                    raise ContractError("publication cut-point self-test did not interrupt")
                renamed = publication_events.index(event) >= publication_events.index("renamed")
                if renamed:
                    if stage.exists() or not final.exists():
                        raise ContractError("post-rename cut point is not resumable")
                    final.unlink()
                else:
                    if not stage.exists() or final.exists():
                        raise ContractError("pre-rename cut point is not resumable")
                    stage.unlink()
        with RootLock(temporary / "locks"):
            try:
                with RootLock(temporary / "locks"):
                    raise AssertionError("unreachable")
            except ContractError:
                pass
        private = temporary / "private"
        ensure_root_private_directory(private)
        outside = temporary / "outside"
        outside.mkdir(mode=0o700)
        symlink = temporary / "private-link"
        symlink.symlink_to(outside, target_is_directory=True)
        try:
            ensure_root_private_directory(symlink)
        except ContractError:
            pass
        else:
            raise ContractError("private-directory self-test accepted a symlink")
        trusted = temporary / "trusted"
        trusted.write_bytes(b"trusted")
        os.chmod(trusted, 0o400)
        hardlink = temporary / "trusted-hardlink"
        os.link(trusted, hardlink)
        try:
            attest_trusted_file(trusted, immutable=True)
        except ContractError:
            pass
        else:
            raise ContractError("trusted-file self-test accepted a hardlink")
        deadline_runner = CommandRunner({"query_seconds": 1, "kill_after_seconds": 1})
        started = time.monotonic()
        try:
            deadline_runner.run(
                ["/usr/bin/python3", "-I", "-c", "import time; time.sleep(30)"],
                phase="query",
            )
        except ContractError:
            pass
        else:
            raise ContractError("command deadline self-test did not time out")
        if time.monotonic() - started > 4:
            raise ContractError("command deadline self-test exceeded its hard bound")
        descendant_pid_path = temporary / "real-descendant-pid"
        descendant_ready_path = temporary / "real-descendant-ready"
        descendant_program = (
            "import os,pathlib,subprocess,sys,time\n"
            "child_code=(\"import pathlib,signal,sys,time; \"\n"
            "            \"signal.signal(signal.SIGTERM, signal.SIG_IGN); \"\n"
            "            \"pathlib.Path(sys.argv[1]).write_text('ready', encoding='ascii'); \"\n"
            "            \"time.sleep(10)\")\n"
            "child=subprocess.Popen([sys.executable,'-I','-c',child_code,sys.argv[2]],\n"
            "    stdin=subprocess.DEVNULL,stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL,close_fds=True)\n"
            "deadline=time.monotonic()+3\n"
            "while not os.path.exists(sys.argv[2]) and time.monotonic()<deadline: time.sleep(0.01)\n"
            "if not os.path.exists(sys.argv[2]): child.kill(); raise SystemExit('descendant readiness timeout')\n"
            "pathlib.Path(sys.argv[1]).write_text(str(child.pid), encoding='ascii')\n"
        )
        descendant_parent = subprocess.Popen(
            [
                "/usr/bin/python3",
                "-I",
                "-c",
                descendant_program,
                str(descendant_pid_path),
                str(descendant_ready_path),
            ],
            stdin=subprocess.DEVNULL,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
            env=deadline_runner.environment,
            close_fds=True,
            start_new_session=True,
        )
        process_group = descendant_parent.pid
        if descendant_parent.wait(timeout=4) != 0 or not descendant_pid_path.is_file():
            raise ContractError("real descendant setup failed")
        descendant_pid_text = descendant_pid_path.read_text(encoding="ascii")
        if not descendant_pid_text.isdigit() or os.getpgid(int(descendant_pid_text)) != process_group:
            raise ContractError("real descendant escaped its captured process group")
        real_cleanup = CommandRunner({"query_seconds": 1, "kill_after_seconds": 1})
        real_cleanup.current = descendant_parent
        real_cleanup.terminate_current()
        try:
            os.killpg(process_group, 0)
        except ProcessLookupError:
            pass
        else:
            raise ContractError("real descendant process group survived cleanup")
        overflow_runner = CommandRunner({"query_seconds": 10, "kill_after_seconds": 1})
        started = time.monotonic()
        emitter = (
            "import os,signal\n"
            "signal.signal(signal.SIGTERM, signal.SIG_IGN)\n"
            "chunk=b'x'*65536\n"
            "while True: os.write(1, chunk)\n"
        )
        try:
            overflow_runner.run(["/usr/bin/python3", "-I", "-c", emitter], phase="query")
        except ContractError as exc:
            if "output exceeded" not in str(exc):
                raise
        else:
            raise ContractError("command output-bound self-test accepted an infinite emitter")
        if time.monotonic() - started > 4 or overflow_runner.current is not None:
            raise ContractError("command output-bound cleanup exceeded its hard bound")
    print("runner-vm-linux-root-self-tests-ok")


def _self_test_wrapper_timeout(arguments: argparse.Namespace) -> None:
    """Exercise the real outer timeout around an exited leader's live group."""

    _require_linux_root()
    contract = _load_contract(Path(arguments.contract), arguments.contract_sha256)
    runner = CommandRunner(contract["deadlines"])
    with tempfile.TemporaryDirectory(
        prefix="codestead-wrapper-timeout-probe-",
        dir="/root",
    ) as temporary_text:
        temporary = Path(temporary_text)
        os.chmod(temporary, 0o700)
        descendant_pid_path = temporary / "descendant-pid"
        ready_path = temporary / "descendant-ready"

        def stop_for_wrapper_timeout(signum: int, _frame: object) -> None:
            current = runner.current
            if current is None:
                raise ContractError("wrapper timeout arrived without a current process group")
            process_group = current.pid
            if current.poll() is None:
                raise ContractError("wrapper timeout leader had not exited")
            if not ready_path.is_file() or not descendant_pid_path.is_file():
                raise ContractError("wrapper timeout descendant was not ready")
            descendant_pid_text = descendant_pid_path.read_text(encoding="ascii")
            if not descendant_pid_text.isdigit():
                raise ContractError("wrapper timeout descendant PID is malformed")
            descendant_pid = int(descendant_pid_text)
            if os.getpgid(descendant_pid) != process_group:
                raise ContractError("wrapper timeout descendant escaped its process group")
            runner.terminate_current()
            try:
                os.killpg(process_group, 0)
            except ProcessLookupError:
                pass
            else:
                raise ContractError(
                    "wrapper timeout descendant process group survived cleanup"
                )
            print(
                f"wrapper-timeout-cleanup-ok pgid={process_group} leader=exited",
                flush=True,
            )
            raise ContractError(
                f"wrapper timeout cleanup completed after signal {signum}"
            )

        signal.signal(signal.SIGTERM, stop_for_wrapper_timeout)
        descendant_program = (
            "import pathlib,signal,subprocess,sys,time\n"
            "child_code=(\"import signal,time; \"\n"
            "            \"signal.signal(signal.SIGTERM, signal.SIG_IGN); \"\n"
            "            \"time.sleep(60)\")\n"
            "child=subprocess.Popen([sys.executable,'-I','-c',child_code],\n"
            "    stdin=subprocess.DEVNULL,close_fds=True)\n"
            "pathlib.Path(sys.argv[1]).write_text(str(child.pid), encoding='ascii')\n"
            "pathlib.Path(sys.argv[2]).write_text('ready', encoding='ascii')\n"
        )
        runner.run(
            [
                "/usr/bin/python3",
                "-I",
                "-c",
                descendant_program,
                str(descendant_pid_path),
                str(ready_path),
            ],
            phase="query",
        )
    raise ContractError("actual wrapper timeout probe was not interrupted")


def _self_test_wrapper_spawn_boundary(arguments: argparse.Namespace) -> None:
    """Hold after setsid spawn until the outer TERM proves deferred ownership."""

    _require_linux_root()
    contract = _load_contract(Path(arguments.contract), arguments.contract_sha256)
    runner = CommandRunner(contract["deadlines"])
    with tempfile.TemporaryDirectory(
        prefix="codestead-wrapper-spawn-probe-",
        dir="/root",
    ) as temporary_text:
        temporary = Path(temporary_text)
        os.chmod(temporary, 0o700)
        child_ready_path = temporary / "child-ready"

        def observe_before_publication(process: subprocess.Popen[Any]) -> None:
            if runner.current is not None or process.pid <= 0:
                raise ContractError("spawn-publication probe lost the unpublished child")
            ready_deadline = time.monotonic() + 2
            while not child_ready_path.is_file():
                if time.monotonic() >= ready_deadline:
                    raise ContractError("spawn-publication child did not become ready")
                time.sleep(0.01)
            signal_deadline = time.monotonic() + 3
            while runner._pending_signal is None:
                if time.monotonic() >= signal_deadline:
                    raise ContractError("outer timeout did not reach the spawn-publication boundary")
                time.sleep(0.01)

        runner._spawn_publication_observer = observe_before_publication

        def stop_for_wrapper_timeout(signum: int, _frame: object) -> None:
            if runner.terminate_current(signum):
                raise ContractError(
                    "wrapper spawn-publication timeout arrived outside the held boundary"
                )

        signal.signal(signal.SIGTERM, stop_for_wrapper_timeout)
        child_program = (
            "import pathlib,signal,sys,time\n"
            "signal.signal(signal.SIGTERM, signal.SIG_IGN)\n"
            "pathlib.Path(sys.argv[1]).write_text('ready', encoding='ascii')\n"
            "time.sleep(60)\n"
        )
        try:
            runner.run(
                [
                    "/usr/bin/python3",
                    "-I",
                    "-c",
                    child_program,
                    str(child_ready_path),
                ],
                phase="query",
            )
        except CommandInterrupted as exc:
            if exc.signum != signal.SIGTERM or runner.current is not None:
                raise ContractError("spawn-publication interruption state was not exact") from exc
            try:
                os.killpg(exc.process_group, 0)
            except ProcessLookupError:
                pass
            else:
                raise ContractError(
                    "wrapper spawn-publication process group survived cleanup"
                ) from exc
            print(
                f"wrapper-spawn-publication-cleanup-ok pgid={exc.process_group} current=cleared",
                flush=True,
            )
            raise ContractError(
                f"wrapper spawn-publication cleanup completed after signal {exc.signum}"
            ) from exc
    raise ContractError("actual wrapper spawn-publication probe was not interrupted")


def _provision(arguments: argparse.Namespace) -> None:
    """Run the trusted preflight and refuse mutation until all contracts pass.

    The complete libvirt lifecycle is intentionally implemented as a sequence
    of attested/semantic phases below.  A real Ubuntu/libvirt integration run
    remains a mandatory external acceptance gate.
    """

    _require_linux_root()
    helper_path = Path(arguments.helper)
    provisioner_path = Path(arguments.provisioner)
    contract_path = Path(arguments.contract)
    helper_identity = attest_trusted_file(helper_path, immutable=True)
    provisioner_identity = attest_trusted_file(provisioner_path, immutable=True)
    del helper_identity, provisioner_identity
    helper_descriptor, _, _ = open_verified_source(
        helper_path,
        expected_sha256=arguments.helper_sha256,
        immutable=True,
    )
    os.close(helper_descriptor)
    contract = _load_contract(contract_path, arguments.contract_sha256)
    for raw_tool in contract["tools"]:
        attest_trusted_executable(Path(raw_tool))
    deadlines = contract["deadlines"]
    runner = CommandRunner(deadlines)

    def stop_for_signal(signum: int, _frame: object) -> None:
        if not runner.terminate_current(signum):
            return
        raise ContractError(f"provisioning interrupted by signal {signum}")

    for handled_signal in (signal.SIGTERM, signal.SIGHUP, signal.SIGINT):
        signal.signal(handled_signal, stop_for_signal)
    validate_osinfo_catalog(
        runner.run(["/usr/bin/virt-install", "--osinfo", "list"], phase="query").stdout
    )

    source_paths = {
        "network": (Path(arguments.network), contract["network_sha256"], 65536),
        "meta": (Path(arguments.meta_data), contract["meta_data_sha256"], 65536),
        "user": (Path(arguments.user_data_template), contract["user_data_template_sha256"], 262144),
    }
    opened: list[int] = []
    source_bytes: dict[str, bytes] = {}
    try:
        for label, (path, digest, maximum) in source_paths.items():
            descriptor, _, content = open_verified_source(
                path,
                expected_sha256=digest,
                immutable=True,
                maximum_bytes=maximum,
            )
            opened.append(descriptor)
            assert content is not None
            source_bytes[label] = content
        validate_network_xml(source_bytes["network"].decode("utf-8"), "source", None)

        key_descriptor, key_identity, key_content = open_verified_source(
            Path(arguments.ssh_key),
            expected_sha256=None,
            immutable=False,
            maximum_bytes=16384,
        )
        opened.append(key_descriptor)
        assert key_content is not None
        base_descriptor, base_identity, _ = open_verified_source(
            Path(arguments.base_image),
            expected_sha256=arguments.base_image_sha256,
            immutable=False,
        )
        opened.append(base_descriptor)
        base_fd_path = f"/proc/self/fd/{base_descriptor}"
        validate_base_image_info(
            runner.run(
                ["/usr/bin/qemu-img", "info", "--output=json", base_fd_path],
                phase="query",
                pass_fds=(base_descriptor,),
            ).stdout,
            base_fd_path,
        )
        runner.run(
            ["/usr/bin/qemu-img", "check", base_fd_path],
            phase="image",
            pass_fds=(base_descriptor,),
        )

        state_directory = Path("/var/lib/libvirt/codestead-runner-provision")
        lock_directory = Path("/run/codestead-runner-provision")
        with RootLock(lock_directory):
            ensure_root_private_directory(state_directory)
            key_stage = state_directory / "operator-key.pub"
            _write_or_verify_immutable(key_stage, key_content, 0o400)
            report = runner.run(
                ["/usr/bin/ssh-keygen", "-lf", str(key_stage), "-E", "sha256"],
                phase="query",
            ).stdout
            key_record = validate_ssh_key_report(key_content.decode("utf-8"), report)

            manifest_path = state_directory / "transaction.json"
            if _lexists(manifest_path):
                manifest_descriptor, manifest_identity, manifest_content = open_verified_source(
                    manifest_path,
                    expected_sha256=None,
                    immutable=False,
                    maximum_bytes=65536,
                )
                os.close(manifest_descriptor)
                if manifest_identity.mode != 0o600:
                    raise ContractError("transaction manifest mode is unsafe")
                assert manifest_content is not None
                manifest_value = parse_json_strict(manifest_content.decode("utf-8"))
                if not isinstance(manifest_value, dict):
                    raise ContractError("transaction manifest is malformed")
                payload = verify_transaction_manifest(manifest_value)
                if payload.get("contract_sha256") != arguments.contract_sha256:
                    raise ContractError("transaction belongs to another reviewed contract")
                if payload.get("base_sha256") != base_identity.sha256 or payload.get("key_fingerprint") != key_record["fingerprint"]:
                    raise ContractError("transaction inputs changed")
                if payload.get("base_identity") != dataclasses.asdict(base_identity) or payload.get("key_identity") != dataclasses.asdict(key_identity):
                    raise ContractError("transaction input file identity changed")
            else:
                if _lexists(Path(EXPECTED_DISK)) or _lexists(Path(EXPECTED_SEED)):
                    raise ContractError("unknown orphan persistent artifact must remain untouched")
                payload = {
                    "version": 1,
                    "transaction_id": uuid.uuid4().hex,
                    "phase": "prepared",
                    "contract_sha256": arguments.contract_sha256,
                    "base_sha256": base_identity.sha256,
                    "base_identity": dataclasses.asdict(base_identity),
                    "key_fingerprint": key_record["fingerprint"],
                    "key_identity": dataclasses.asdict(key_identity),
                }
                _atomic_write_manifest(manifest_path, payload)

            # Exact libvirt absence/existence and lifecycle mutations are
            # intentionally delegated to the phase implementation below.
            # Reaching this point proves the P0 trust boundary before any
            # libvirt or storage mutation.
            _run_libvirt_transaction(runner, contract, payload, manifest_path, source_bytes, key_content, base_descriptor)
    finally:
        for descriptor in opened:
            try:
                os.close(descriptor)
            except OSError:
                pass


def exact_name_is_present(output: str, expected: str) -> bool:
    """Parse a C-locale ``virsh ... --name`` response without substring matches."""

    names = [line.strip() for line in output.splitlines() if line.strip()]
    if any(not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9_.-]{0,127}", name) for name in names):
        raise ContractError("libvirt name list contains malformed identity")
    if len(names) != len(set(names)):
        raise ContractError("libvirt name list returned duplicate identity")
    return expected in names


def parse_virsh_info(output: str, kind: str, *, require_ready: bool = True) -> dict[str, Any]:
    """Parse and enforce persistent/autostart semantics from C-locale virsh info."""

    if kind not in {"network", "domain"}:
        raise ContractError("unknown virsh info kind")
    values: dict[str, str] = {}
    for raw_line in output.splitlines():
        if not raw_line.strip():
            continue
        if ":" not in raw_line:
            raise ContractError("virsh info contains a malformed line")
        key, value = (piece.strip() for piece in raw_line.split(":", 1))
        if not key or key in values:
            raise ContractError("virsh info contains duplicate/empty field")
        values[key] = value
    common = {"Name", "UUID", "Persistent", "Autostart"}
    allowed = (
        common | {"Active", "Bridge"}
        if kind == "network"
        else common
        | {
            "Id", "OS Type", "State", "CPU(s)", "CPU time", "Max memory",
            "Used memory", "Managed save", "Security model", "Security DOI",
            "Messages",
        }
    )
    if set(values) - allowed:
        raise ContractError(f"virsh {kind} info contains unexpected fields")
    if not common <= set(values):
        raise ContractError(f"virsh {kind} info is incomplete")
    expected_name = NETWORK_NAME if kind == "network" else DOMAIN_NAME
    if values["Name"] != expected_name or not _valid_uuid(values["UUID"]):
        raise ContractError(f"virsh {kind} identity drift")
    persistent = values["Persistent"] == "yes"
    autostart = values["Autostart"] in {"yes", "enable"}
    if not persistent or (require_ready and not autostart):
        raise ContractError(f"virsh {kind} is not persistent and autostarted")
    if kind == "network":
        if values.get("Bridge") != NETWORK_BRIDGE or (require_ready and values.get("Active") != "yes"):
            raise ContractError("default network is not active on the reviewed bridge")
    else:
        if values.get("CPU(s)") not in {None, "4"}:
            raise ContractError("domain info vCPU count drift")
        if values.get("Max memory") not in {None, "8388608 KiB"}:
            raise ContractError("domain info maximum memory drift")
        if require_ready and values.get("State") != "running":
            raise ContractError("domain is not running")
    return {
        "name": values["Name"],
        "uuid": values["UUID"],
        "persistent": persistent,
        "autostart": autostart,
        "active": values.get("Active") == "yes" if kind == "network" else values.get("State") == "running",
        "raw": values,
    }


def parse_inactive_block_list(output: str) -> tuple[tuple[str, str, str, str], ...]:
    """Require exactly the reviewed persistent disk and seed block sources."""

    rows: list[tuple[str, str, str, str]] = []
    for raw_line in output.splitlines():
        line = raw_line.strip()
        if not line or line.startswith("Type ") or set(line) == {"-"}:
            continue
        parts = line.split(None, 3)
        if len(parts) != 4:
            raise ContractError("virsh domblklist contains malformed row")
        rows.append((parts[0], parts[1], parts[2], parts[3]))
    expected = {
        ("file", "disk", "vda", EXPECTED_DISK),
        ("file", "cdrom", "sda", EXPECTED_SEED),
    }
    if len(rows) != 2 or set(rows) != expected:
        raise ContractError("persistent domain block sources drift")
    return tuple(rows)


@dataclasses.dataclass(frozen=True)
class NetworkObservation:
    """One UUID-bound view of the persistent and optional live default network."""

    uuid: str
    active: bool
    autostart: bool
    inactive: Mapping[str, Any]
    live: Mapping[str, Any] | None


def _observe_default_network(runner: CommandRunner) -> NetworkObservation | None:
    names = runner.run(
        ["/usr/bin/virsh", "--connect", "qemu:///system", "net-list", "--all", "--name"],
        phase="query",
    ).stdout
    if not exact_name_is_present(names, NETWORK_NAME):
        return None
    network_uuid = runner.run(
        ["/usr/bin/virsh", "--connect", "qemu:///system", "net-uuid", NETWORK_NAME],
        phase="query",
    ).stdout.strip()
    if not _valid_uuid(network_uuid):
        raise ContractError("default network has no unambiguous UUID")
    info = parse_virsh_info(
        runner.run(
            ["/usr/bin/virsh", "--connect", "qemu:///system", "net-info", network_uuid],
            phase="query",
        ).stdout,
        "network",
        require_ready=False,
    )
    if info["uuid"] != network_uuid:
        raise ContractError("default network UUID changed during inspection")
    inactive = validate_network_xml(
        runner.run(
            [
                "/usr/bin/virsh", "--connect", "qemu:///system", "net-dumpxml",
                network_uuid, "--inactive",
            ],
            phase="query",
        ).stdout,
        "inactive",
        network_uuid,
    )
    live: Mapping[str, Any] | None = None
    if info["active"]:
        live = validate_network_xml(
            runner.run(
                ["/usr/bin/virsh", "--connect", "qemu:///system", "net-dumpxml", network_uuid],
                phase="query",
            ).stdout,
            "live",
            network_uuid,
        )
        if live["non_target_sha256"] != inactive["non_target_sha256"]:
            raise ContractError("default network live/config non-target semantics differ")
    return NetworkObservation(network_uuid, info["active"], info["autostart"], inactive, live)


def _assert_network_baseline(observed: NetworkObservation, expected: NetworkObservation) -> None:
    if observed.uuid != expected.uuid:
        raise ContractError("default network UUID changed during the transaction")
    if observed.inactive["non_target_sha256"] != expected.inactive["non_target_sha256"]:
        raise ContractError("default network non-target configuration changed concurrently")
    if observed.live is not None and observed.live["non_target_sha256"] != expected.inactive["non_target_sha256"]:
        raise ContractError("default network live non-target configuration changed concurrently")


def _validate_active_default_leases(runner: CommandRunner, network_uuid: str) -> None:
    validate_default_network_leases(
        runner.run(
            [
                "/usr/bin/virsh", "--connect", "qemu:///system", "net-dhcp-leases",
                network_uuid,
            ],
            phase="query",
        ).stdout
    )


def _converge_default_network(
    runner: CommandRunner,
    payload: dict[str, Any],
    manifest_path: Path,
    network_stage: Path,
) -> str:
    """Converge only the owned reservation and power lifecycle of ``default``."""

    observed = _observe_default_network(runner)
    if observed is None:
        payload.update({"network_phase": "define-intent", "network_origin": "defined"})
        _atomic_write_manifest(manifest_path, payload)
        if _observe_default_network(runner) is not None:
            raise ContractError("default network appeared before reviewed definition")
        runner.run(
            [
                "/usr/bin/virsh", "--connect", "qemu:///system", "net-define",
                str(network_stage), "--validate",
            ],
            phase="mutation",
        )
        observed = _observe_default_network(runner)
        if observed is None:
            raise ContractError("defined default network did not become persistent")
    else:
        payload.setdefault("network_origin", "preexisting")

    recorded_uuid = payload.get("network_uuid")
    if recorded_uuid is not None and recorded_uuid != observed.uuid:
        raise ContractError("transaction belongs to another default-network UUID")
    payload["network_uuid"] = observed.uuid
    payload.setdefault("network_non_target_sha256", observed.inactive["non_target_sha256"])
    if payload["network_non_target_sha256"] != observed.inactive["non_target_sha256"]:
        raise ContractError("default network changed since transaction intent was recorded")

    live_present = bool(observed.live and observed.live["reservation_present"])
    if observed.active:
        _validate_active_default_leases(runner, observed.uuid)
    update_config, update_live = reservation_update_plan(
        bool(observed.inactive["reservation_present"]), live_present, observed.active
    )
    if update_config or update_live:
        payload["network_phase"] = "reservation-intent"
        payload["network_update_config"] = update_config
        payload["network_update_live"] = update_live
        _atomic_write_manifest(manifest_path, payload)
        before = _observe_default_network(runner)
        if before is None:
            raise ContractError("default network disappeared before reservation update")
        _assert_network_baseline(before, observed)
        if before.active:
            _validate_active_default_leases(runner, before.uuid)
        update_config, update_live = reservation_update_plan(
            bool(before.inactive["reservation_present"]),
            bool(before.live and before.live["reservation_present"]),
            before.active,
        )
        if update_config or update_live:
            # Use the UUID proven by the immediately preceding observation.
            # A concurrent name replacement can therefore never redirect the
            # additive update to an unrelated network.
            command = build_network_update_command(before.uuid, update_config, update_live)
            payload["network_phase"] = "reservation-updating"
            _atomic_write_manifest(manifest_path, payload)
            runner.run(command, phase="mutation")
        after = _observe_default_network(runner)
        if after is None:
            raise ContractError("default network disappeared after reservation update")
        _assert_network_baseline(after, observed)
        expected_config, expected_live = reservation_update_plan(
            bool(after.inactive["reservation_present"]),
            bool(after.live and after.live["reservation_present"]),
            after.active,
        )
        if expected_config or expected_live:
            raise ContractError("default network reservation update did not converge")
        observed = after

    if not observed.autostart:
        payload["network_phase"] = "autostart-intent"
        _atomic_write_manifest(manifest_path, payload)
        runner.run(
            ["/usr/bin/virsh", "--connect", "qemu:///system", "net-autostart", observed.uuid],
            phase="mutation",
        )
    if not observed.active:
        payload["network_phase"] = "start-intent"
        _atomic_write_manifest(manifest_path, payload)
        runner.run(
            ["/usr/bin/virsh", "--connect", "qemu:///system", "net-start", observed.uuid],
            phase="mutation",
        )

    ready = _observe_default_network(runner)
    if ready is None or ready.uuid != observed.uuid:
        raise ContractError("default network identity changed during lifecycle convergence")
    parse_virsh_info(
        runner.run(
            ["/usr/bin/virsh", "--connect", "qemu:///system", "net-info", ready.uuid],
            phase="query",
        ).stdout,
        "network",
    )
    _assert_network_baseline(ready, observed)
    _validate_active_default_leases(runner, ready.uuid)
    if not ready.inactive["reservation_present"] or not ready.live or not ready.live["reservation_present"]:
        raise ContractError("default network reservation is not present in config and live XML")
    payload["network_phase"] = "ready"
    payload["network_uuid"] = ready.uuid
    _atomic_write_manifest(manifest_path, payload)
    return ready.uuid


def _require_ready_default_network(runner: CommandRunner, expected_uuid: str) -> NetworkObservation:
    network = _observe_default_network(runner)
    if (
        network is None
        or network.uuid != expected_uuid
        or not network.active
        or not network.autostart
        or not network.inactive["reservation_present"]
        or not network.live
        or not network.live["reservation_present"]
    ):
        raise ContractError("default network is not ready for runner-domain mutation")
    _validate_active_default_leases(runner, network.uuid)
    return network


def _run_libvirt_transaction(
    runner: CommandRunner,
    contract: Mapping[str, Any],
    payload: dict[str, Any],
    manifest_path: Path,
    source_bytes: Mapping[str, bytes],
    key_content: bytes,
    base_descriptor: int,
) -> None:
    """Execute a resumable, UUID-bound libvirt provisioning transaction."""

    del key_content
    service = runner.run(["/usr/bin/systemctl", "is-active", "libvirtd.service"], phase="query").stdout.strip()
    if service != "active":
        raise ContractError("libvirtd.service is not active")
    preflight_uid, preflight_gid = _preflight_kvm_and_storage(runner)
    _preflight_owned_artifacts(runner, payload, preflight_uid, preflight_gid)
    domain_stage = manifest_path.parent / "domain.xml"
    if _lexists(domain_stage):
        expected_domain_digest = payload.get("domain_xml_sha256")
        expected_domain_uuid = payload.get("domain_uuid_intent")
        if not isinstance(expected_domain_digest, str) or not isinstance(expected_domain_uuid, str):
            raise ContractError("staged domain XML has no recorded transaction identity")
        descriptor, _, staged_domain = open_verified_source(
            domain_stage,
            expected_sha256=expected_domain_digest,
            immutable=True,
            maximum_bytes=1024 * 1024,
        )
        os.close(descriptor)
        assert staged_domain is not None
        validate_domain_xml(staged_domain.decode("utf-8"), "inactive", expected_domain_uuid)
    domain_names = runner.run(
        ["/usr/bin/virsh", "--connect", "qemu:///system", "list", "--all", "--name"],
        phase="query",
    ).stdout
    domain_exists = exact_name_is_present(domain_names, DOMAIN_NAME)

    # Validate every pre-existing runner-domain artifact before the first
    # network/storage mutation. The same checks are repeated after network
    # convergence to close the race window.
    if domain_exists:
        preflight_uuid = runner.run(
            ["/usr/bin/virsh", "--connect", "qemu:///system", "domuuid", DOMAIN_NAME],
            phase="query",
        ).stdout.strip()
        if not _valid_uuid(preflight_uuid):
            raise ContractError("pre-existing runner domain has ambiguous identity")
        validate_domain_xml(
            runner.run(
                [
                    "/usr/bin/virsh", "--connect", "qemu:///system", "dumpxml",
                    preflight_uuid, "--inactive",
                ],
                phase="query",
            ).stdout,
            "inactive",
            preflight_uuid,
        )
        parse_inactive_block_list(
            runner.run(
                [
                    "/usr/bin/virsh", "--connect", "qemu:///system", "domblklist",
                    preflight_uuid, "--inactive", "--details",
                ],
                phase="query",
            ).stdout
        )
        preflight_info = parse_virsh_info(
            runner.run(
                ["/usr/bin/virsh", "--connect", "qemu:///system", "dominfo", preflight_uuid],
                phase="query",
            ).stdout,
            "domain",
            require_ready=False,
        )
        preflight_state = str(preflight_info["raw"].get("State", ""))
        if preflight_state not in {"running", "shut off"}:
            raise ContractError(f"runner domain state is not safely recoverable: {preflight_state}")
        _verify_storage(runner, payload, preflight_state == "running")

    state_directory = manifest_path.parent
    network_stage = state_directory / "network.xml"
    if not _lexists(network_stage):
        descriptor = os.open(
            network_stage,
            os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_CLOEXEC | os.O_NOFOLLOW,
            0o400,
        )
        try:
            _write_all(descriptor, source_bytes["network"])
            os.fchmod(descriptor, 0o400)
            os.fsync(descriptor)
        finally:
            os.close(descriptor)
    else:
        stage_descriptor, _, stage_content = open_verified_source(
            network_stage,
            expected_sha256=hashlib.sha256(source_bytes["network"]).hexdigest(),
            immutable=True,
            maximum_bytes=65536,
        )
        os.close(stage_descriptor)
        if stage_content != source_bytes["network"]:
            raise ContractError("staged default-network XML changed")

    network_uuid = _converge_default_network(runner, payload, manifest_path, network_stage)

    # If a persistent domain already exists, require complete inactive/live
    # compatibility and the exact completed transaction manifest.
    if domain_exists:
        domain_uuid = runner.run(
            ["/usr/bin/virsh", "--connect", "qemu:///system", "domuuid", DOMAIN_NAME],
            phase="query",
        ).stdout.strip()
        recorded_uuid = payload.get("domain_uuid", payload.get("domain_uuid_intent"))
        if not _valid_uuid(domain_uuid) or (recorded_uuid is not None and recorded_uuid != domain_uuid):
            raise ContractError("same-name domain UUID is ambiguous or changed")
        inactive_domain = runner.run(
            ["/usr/bin/virsh", "--connect", "qemu:///system", "dumpxml", DOMAIN_NAME, "--inactive"],
            phase="query",
        ).stdout
        validate_domain_xml(inactive_domain, "inactive", domain_uuid)
        parse_inactive_block_list(
            runner.run(
                [
                    "/usr/bin/virsh", "--connect", "qemu:///system", "domblklist",
                    domain_uuid, "--inactive", "--details",
                ],
                phase="query",
            ).stdout
        )
        domain_info = parse_virsh_info(
            runner.run(
                ["/usr/bin/virsh", "--connect", "qemu:///system", "dominfo", domain_uuid],
                phase="query",
            ).stdout,
            "domain",
            require_ready=False,
        )
        live_state = str(domain_info["raw"].get("State", ""))
        if live_state not in {"running", "shut off"}:
            raise ContractError(f"domain state is not safely recoverable: {live_state}")
        _verify_storage(runner, payload, live_state == "running")
        if not domain_info["autostart"]:
            payload["phase"] = "domain-autostart-intent"
            _atomic_write_manifest(manifest_path, payload)
            runner.run(
                ["/usr/bin/virsh", "--connect", "qemu:///system", "autostart", domain_uuid],
                phase="mutation",
            )
        if live_state == "shut off":
            payload["phase"] = "domain-start-intent"
            _atomic_write_manifest(manifest_path, payload)
            runner.run(
                ["/usr/bin/virsh", "--connect", "qemu:///system", "start", domain_uuid],
                phase="mutation",
            )
        ready_info = parse_virsh_info(
            runner.run(
                ["/usr/bin/virsh", "--connect", "qemu:///system", "dominfo", domain_uuid],
                phase="query",
            ).stdout,
            "domain",
        )
        if ready_info["uuid"] != domain_uuid:
            raise ContractError("domain UUID changed during lifecycle convergence")
        live_domain = runner.run(
            ["/usr/bin/virsh", "--connect", "qemu:///system", "dumpxml", domain_uuid],
            phase="query",
        ).stdout
        validate_domain_xml(
            live_domain,
            "live",
            domain_uuid,
            preflight_uid,
            preflight_gid,
        )
        payload["domain_uuid"] = domain_uuid
        payload["phase"] = "completed"
        _atomic_write_manifest(manifest_path, payload)
        return

    _prepare_and_publish_artifacts(runner, contract, payload, manifest_path, source_bytes, base_descriptor)
    _define_and_start_domain(
        runner,
        payload,
        manifest_path,
        network_uuid,
        preflight_uid,
        preflight_gid,
    )


def _artifact_identity(path: Path, expected_uid: int, expected_gid: int) -> FileIdentity:
    info = os.lstat(path)
    if not stat.S_ISREG(info.st_mode) or stat.S_ISLNK(info.st_mode):
        raise ContractError(f"persistent artifact is not a regular no-follow file: {path}")
    if info.st_uid != expected_uid or info.st_gid != expected_gid or stat.S_IMODE(info.st_mode) != 0o600 or info.st_nlink != 1:
        raise ContractError(f"persistent artifact ownership/mode/link drift: {path}")
    return FileIdentity.from_stat(info)


def _require_recorded_identity(
    label: str,
    recorded: Any,
    observed: FileIdentity,
    *,
    allow_size_change: bool = False,
) -> None:
    if not isinstance(recorded, dict):
        raise ContractError(f"{label} has no recorded transaction identity")
    fields = ("device", "inode", "mode", "uid", "gid", "nlink")
    if not allow_size_change:
        fields += ("size",)
    if any(recorded.get(field) != getattr(observed, field) for field in fields):
        raise ContractError(f"{label} transaction identity drift")


def _fsync_directory(path: Path) -> None:
    descriptor = os.open(path, os.O_RDONLY | os.O_DIRECTORY | os.O_CLOEXEC)
    try:
        os.fsync(descriptor)
    finally:
        os.close(descriptor)


def _lexists(path: Path) -> bool:
    try:
        os.lstat(path)
    except FileNotFoundError:
        return False
    return True


def _sha256_regular_file(path: Path, maximum_bytes: int) -> str:
    descriptor = os.open(path, os.O_RDONLY | os.O_CLOEXEC | os.O_NOFOLLOW)
    try:
        before = os.fstat(descriptor)
        if (
            not stat.S_ISREG(before.st_mode)
            or before.st_nlink != 1
            or before.st_size > maximum_bytes
        ):
            raise ContractError(f"bounded hash input is unsafe: {path}")
        digest = hashlib.sha256()
        consumed = 0
        while True:
            chunk = os.read(descriptor, 1024 * 1024)
            if not chunk:
                break
            consumed += len(chunk)
            if consumed > maximum_bytes:
                raise ContractError(f"bounded hash input grew beyond its limit: {path}")
            digest.update(chunk)
        after = os.fstat(descriptor)
        if (before.st_dev, before.st_ino, before.st_size, before.st_mtime_ns) != (
            after.st_dev,
            after.st_ino,
            after.st_size,
            after.st_mtime_ns,
        ):
            raise ContractError(f"bounded hash input changed while reading: {path}")
        return digest.hexdigest()
    finally:
        os.close(descriptor)


def _discard_owned_partial(path: Path, payload: Mapping[str, Any], label: str) -> None:
    """Remove only a manifest-owned interrupted build, never an unknown file."""

    if not _lexists(path):
        return
    if payload.get("phase") != f"building-{label}" or payload.get(f"{label}_stage") != str(path):
        raise ContractError(f"unrecorded partial {label} stage must remain untouched")
    info = os.lstat(path)
    expected_uid = payload.get("qemu_uid")
    expected_gid = payload.get("qemu_gid")
    if (
        stat.S_ISLNK(info.st_mode)
        or not stat.S_ISREG(info.st_mode)
        or info.st_nlink != 1
        or info.st_uid not in {0, expected_uid}
        or info.st_gid not in {0, expected_gid}
    ):
        raise ContractError(f"partial {label} stage identity is unsafe")
    os.unlink(path)
    _fsync_directory(path.parent)


def _qemu_identity(runner: CommandRunner) -> tuple[int, int]:
    uid_text = runner.run(["/usr/bin/id", "-u", "libvirt-qemu"], phase="query").stdout.strip()
    group_lines = runner.run(["/usr/bin/getent", "group", "kvm"], phase="query").stdout.splitlines()
    if len(group_lines) != 1:
        raise ContractError("could not resolve one fixed QEMU group")
    group_fields = group_lines[0].split(":")
    if len(group_fields) != 4 or group_fields[0] != "kvm":
        raise ContractError("fixed QEMU group record is malformed")
    gid_text = group_fields[2]
    if not uid_text.isdigit() or not gid_text.isdigit():
        raise ContractError("could not resolve fixed QEMU uid/gid")
    return int(uid_text), int(gid_text)


def _preflight_kvm_and_storage(runner: CommandRunner) -> tuple[int, int]:
    try:
        kvm = os.lstat("/dev/kvm")
    except OSError as exc:
        raise ContractError("/dev/kvm is unavailable") from exc
    if stat.S_ISLNK(kvm.st_mode) or not stat.S_ISCHR(kvm.st_mode) or kvm.st_uid != 0:
        raise ContractError("/dev/kvm is not the reviewed root-owned character device")
    uid, gid = _qemu_identity(runner)
    for directory in (Path(EXPECTED_DISK).parent, Path(EXPECTED_SEED).parent):
        _attest_ancestor_chain(directory / "sentinel")
        info = os.lstat(directory)
        if (
            not stat.S_ISDIR(info.st_mode)
            or stat.S_ISLNK(info.st_mode)
            or info.st_uid != 0
            or stat.S_IMODE(info.st_mode) & 0o022
        ):
            raise ContractError(f"libvirt storage directory is unsafe: {directory}")
    return uid, gid


def _preflight_owned_artifacts(
    runner: CommandRunner,
    payload: Mapping[str, Any],
    uid: int,
    gid: int,
) -> None:
    transaction_id = payload.get("transaction_id")
    if not isinstance(transaction_id, str) or not re.fullmatch(r"[0-9a-f]{32}", transaction_id):
        raise ContractError("transaction identifier is malformed")
    paths = {
        "disk_stage": Path(EXPECTED_DISK).parent / f".codestead-runner.{transaction_id}.disk.stage",
        "seed_stage": Path(EXPECTED_SEED).parent / f".codestead-runner.{transaction_id}.seed.stage",
        "disk": Path(EXPECTED_DISK),
        "seed": Path(EXPECTED_SEED),
    }
    for label, path in paths.items():
        if not _lexists(path):
            continue
        record_key = f"{label}_identity"
        recorded = payload.get(record_key)
        if recorded is None and label in {"disk", "seed"}:
            recorded = payload.get(f"{label}_stage_identity")
        if recorded is None and label.endswith("_stage"):
            artifact = label.removesuffix("_stage")
            if payload.get("phase") == f"building-{artifact}" and payload.get(label) == str(path):
                info = os.lstat(path)
                if stat.S_ISLNK(info.st_mode) or not stat.S_ISREG(info.st_mode) or info.st_nlink != 1:
                    raise ContractError(f"interrupted {label} identity is unsafe")
                continue
        observed = _artifact_identity(path, uid, gid)
        _require_recorded_identity(label, recorded, observed, allow_size_change=label == "disk")
        if label.startswith("disk"):
            info_command = ["/usr/bin/qemu-img", "info"]
            if label == "disk":
                info_command.append("--force-share")
            info_command.extend(["--output=json", str(path)])
            parse_image_info(
                runner.run(
                    info_command,
                    phase="query",
                ).stdout,
                str(path),
            )
        else:
            expected_digest = payload.get("seed_sha256")
            if not isinstance(expected_digest, str) or not hmac.compare_digest(
                _sha256_regular_file(path, 1024 * 1024 * 1024), expected_digest
            ):
                raise ContractError(f"{label} content drift")


def _prepare_and_publish_artifacts(
    runner: CommandRunner,
    contract: Mapping[str, Any],
    payload: dict[str, Any],
    manifest_path: Path,
    source_bytes: Mapping[str, bytes],
    base_descriptor: int,
) -> None:
    del contract
    images = Path(EXPECTED_DISK).parent
    boot = Path(EXPECTED_SEED).parent
    for directory in (images, boot):
        _attest_ancestor_chain(directory / "sentinel")
        info = os.lstat(directory)
        if (
            info.st_uid != 0
            or not stat.S_ISDIR(info.st_mode)
            or stat.S_IMODE(info.st_mode) & 0o022
        ):
            raise ContractError(f"libvirt storage directory is not root-owned/non-writable: {directory}")
    uid, gid = _qemu_identity(runner)
    transaction_id = payload.get("transaction_id")
    if not isinstance(transaction_id, str) or not re.fullmatch(r"[0-9a-f]{32}", transaction_id):
        raise ContractError("transaction identifier is malformed")
    disk_stage = images / f".codestead-runner.{transaction_id}.disk.stage"
    seed_stage = boot / f".codestead-runner.{transaction_id}.seed.stage"
    for key, value in {
        "disk_stage": str(disk_stage),
        "seed_stage": str(seed_stage),
        "qemu_uid": uid,
        "qemu_gid": gid,
    }.items():
        if key in payload and payload[key] != value:
            raise ContractError(f"transaction {key} changed")
        payload[key] = value

    disk_final = Path(EXPECTED_DISK)
    seed_final = Path(EXPECTED_SEED)

    if _lexists(disk_stage) and "disk_stage_identity" not in payload:
        _discard_owned_partial(disk_stage, payload, "disk")
    if _lexists(seed_stage) and "seed_stage_identity" not in payload:
        _discard_owned_partial(seed_stage, payload, "seed")

    if not _lexists(disk_stage) and not _lexists(disk_final):
        payload["phase"] = "building-disk"
        _atomic_write_manifest(manifest_path, payload)
        runner.run(
            [
                "/usr/bin/qemu-img", "convert", "-O", "qcow2",
                f"/proc/self/fd/{base_descriptor}", str(disk_stage),
            ],
            phase="image",
            pass_fds=(base_descriptor,),
        )
        runner.run(["/usr/bin/qemu-img", "resize", str(disk_stage), "100G"], phase="image")
        os.chown(disk_stage, uid, gid)
        os.chmod(disk_stage, 0o600)
        disk_identity = _artifact_identity(disk_stage, uid, gid)
        parse_image_info(
            runner.run(
                ["/usr/bin/qemu-img", "info", "--output=json", str(disk_stage)],
                phase="query",
            ).stdout,
            str(disk_stage),
        )
        payload["disk_stage_identity"] = dataclasses.asdict(disk_identity)
        payload["phase"] = "disk-ready"
        _atomic_write_manifest(manifest_path, payload)

    if _lexists(disk_stage):
        disk_stage_identity = _artifact_identity(disk_stage, uid, gid)
        _require_recorded_identity("disk stage", payload.get("disk_stage_identity"), disk_stage_identity)
        parse_image_info(
            runner.run(
                ["/usr/bin/qemu-img", "info", "--output=json", str(disk_stage)],
                phase="query",
            ).stdout,
            str(disk_stage),
        )

    if not _lexists(seed_stage) and not _lexists(seed_final):
        state = manifest_path.parent
        placeholder = b"__RUNNER_ADMIN_SSH_PUBLIC_KEY__"
        if source_bytes["user"].count(placeholder) != 1:
            raise ContractError("cloud-init template must contain exactly one key placeholder")
        key_descriptor, _, key_bytes = open_verified_source(
            state / "operator-key.pub",
            expected_sha256=None,
            immutable=True,
            maximum_bytes=16384,
        )
        os.close(key_descriptor)
        assert key_bytes is not None
        rendered = source_bytes["user"].replace(placeholder, key_bytes.strip())
        rendered_path = state / "rendered-user-data"
        meta_path = state / "meta-data"
        _write_or_verify_immutable(rendered_path, rendered, 0o400)
        _write_or_verify_immutable(meta_path, source_bytes["meta"], 0o400)
        payload["rendered_user_sha256"] = hashlib.sha256(rendered).hexdigest()
        payload["meta_sha256"] = hashlib.sha256(source_bytes["meta"]).hexdigest()
        payload["phase"] = "building-seed"
        _atomic_write_manifest(manifest_path, payload)
        runner.run(
            ["/usr/bin/cloud-localds", str(seed_stage), str(rendered_path), str(meta_path)],
            phase="mutation",
        )
        os.chown(seed_stage, uid, gid)
        os.chmod(seed_stage, 0o600)
        seed_identity = _artifact_identity(seed_stage, uid, gid)
        seed_digest = _sha256_regular_file(seed_stage, 1024 * 1024 * 1024)
        payload["seed_stage_identity"] = dataclasses.asdict(seed_identity)
        payload["seed_sha256"] = seed_digest
        payload["phase"] = "seed-ready"
        _atomic_write_manifest(manifest_path, payload)

    if _lexists(seed_stage):
        seed_stage_identity = _artifact_identity(seed_stage, uid, gid)
        _require_recorded_identity("seed stage", payload.get("seed_stage_identity"), seed_stage_identity)
        if not hmac.compare_digest(
            _sha256_regular_file(seed_stage, 1024 * 1024 * 1024),
            str(payload.get("seed_sha256", "")),
        ):
            raise ContractError("seed stage content drift")

    # A crash after rename but before the next manifest write is recovered by
    # proving that the final inode is the recorded stage inode.
    if _lexists(disk_final):
        disk_identity = _artifact_identity(disk_final, uid, gid)
        recorded = payload.get("disk_identity", payload.get("disk_stage_identity"))
        _require_recorded_identity("final disk", recorded, disk_identity, allow_size_change=True)
        payload["disk_identity"] = dataclasses.asdict(disk_identity)
        parse_image_info(
            runner.run(
                ["/usr/bin/qemu-img", "info", "--output=json", str(disk_final)],
                phase="query",
            ).stdout,
            str(disk_final),
        )
    if _lexists(seed_final):
        seed_identity = _artifact_identity(seed_final, uid, gid)
        recorded = payload.get("seed_identity", payload.get("seed_stage_identity"))
        _require_recorded_identity("final seed", recorded, seed_identity)
        payload["seed_identity"] = dataclasses.asdict(seed_identity)
        if not hmac.compare_digest(
            _sha256_regular_file(seed_final, 1024 * 1024 * 1024),
            str(payload.get("seed_sha256", "")),
        ):
            raise ContractError("final seed content drift")

    def state(path: Path, recorded: Any) -> str:
        if not _lexists(path):
            return "missing"
        observed_identity = _artifact_identity(path, uid, gid)
        try:
            _require_recorded_identity(
                str(path),
                recorded,
                observed_identity,
                allow_size_change=path == disk_final,
            )
        except ContractError:
            return "unknown"
        return "owned"

    disk_stage_state = state(disk_stage, payload.get("disk_stage_identity"))
    disk_final_state = state(
        disk_final,
        payload.get("disk_identity", payload.get("disk_stage_identity")),
    )
    seed_stage_state = state(seed_stage, payload.get("seed_stage_identity"))
    seed_final_state = state(
        seed_final,
        payload.get("seed_identity", payload.get("seed_stage_identity")),
    )
    action = reconcile_transaction_state(
        str(payload.get("phase", "")),
        disk_stage_state,
        disk_final_state,
        seed_stage_state,
        seed_final_state,
        False,
    )
    if action == "publish-disk":
        payload["phase"] = "publishing-disk"
        _atomic_write_manifest(manifest_path, payload)
        rename_noreplace(disk_stage, disk_final, payload["disk_stage_identity"])
        disk_identity = _artifact_identity(disk_final, uid, gid)
        _require_recorded_identity("published disk", payload["disk_stage_identity"], disk_identity)
        payload["disk_identity"] = dataclasses.asdict(disk_identity)
        _atomic_write_manifest(manifest_path, payload)
        action = "publish-seed"
    if action == "publish-seed":
        payload["phase"] = "publishing-seed"
        _atomic_write_manifest(manifest_path, payload)
        rename_noreplace(seed_stage, seed_final, payload["seed_stage_identity"])
        seed_identity = _artifact_identity(seed_final, uid, gid)
        _require_recorded_identity("published seed", payload["seed_stage_identity"], seed_identity)
        payload["seed_identity"] = dataclasses.asdict(seed_identity)
        _atomic_write_manifest(manifest_path, payload)
        action = "define-domain"
    if action != "define-domain":
        raise ContractError(f"artifact transaction did not converge: {action}")
    payload["phase"] = "defining-domain"
    _atomic_write_manifest(manifest_path, payload)


def _define_and_start_domain(
    runner: CommandRunner,
    payload: dict[str, Any],
    manifest_path: Path,
    network_uuid: str | None,
    preflight_uid: int,
    preflight_gid: int,
) -> None:
    if network_uuid is None:
        raise ContractError("network UUID was not captured")
    _require_ready_default_network(runner, network_uuid)
    domain_stage = manifest_path.parent / "domain.xml"
    if _lexists(domain_stage):
        descriptor, _, staged = open_verified_source(
            domain_stage,
            expected_sha256=payload.get("domain_xml_sha256"),
            immutable=True,
            maximum_bytes=1024 * 1024,
        )
        os.close(descriptor)
        assert staged is not None
        generated = _parse_xml(staged.decode("utf-8"), "domain")
        domain_uuid = _text(_one(generated, "uuid"))
        if payload.get("domain_uuid_intent") != domain_uuid:
            raise ContractError("staged domain XML belongs to another transaction")
        validate_domain_xml(staged.decode("utf-8"), "inactive", domain_uuid)
    else:
        xml_text = runner.run(
            [
                "/usr/bin/virt-install", "--connect", "qemu:///system", "--name", DOMAIN_NAME,
                "--virt-type", "kvm", "--vcpus", "4", "--memory", "8192", "--cpu", "host-passthrough",
                "--osinfo", EXPECTED_OSINFO, "--import",
                "--disk", f"path={EXPECTED_DISK},bus=virtio,format=qcow2,cache=none",
                "--disk", f"path={EXPECTED_SEED},device=cdrom,bus=sata,readonly=on",
                "--network", f"network={NETWORK_NAME},mac={EXPECTED_MAC},model=virtio",
                "--graphics", "none", "--noautoconsole", "--print-xml",
            ],
            phase="mutation",
        ).stdout
        generated = _normalize_noble_virt_install_domain(xml_text)
        uuid_node = _one(generated, "uuid")
        domain_uuid = _text(uuid_node)
        domain_bytes = ET.tostring(generated, encoding="utf-8")
        payload["domain_uuid_intent"] = domain_uuid
        payload["domain_xml_sha256"] = hashlib.sha256(domain_bytes).hexdigest()
        payload["phase"] = "domain-stage-intent"
        _atomic_write_manifest(manifest_path, payload)
        descriptor = os.open(
            domain_stage,
            os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_CLOEXEC | os.O_NOFOLLOW,
            0o400,
        )
        try:
            _write_all(descriptor, domain_bytes)
            os.fchmod(descriptor, 0o400)
            os.fsync(descriptor)
        finally:
            os.close(descriptor)

    # Recheck no same-name domain immediately before definition.
    names = runner.run(["/usr/bin/virsh", "--connect", "qemu:///system", "list", "--all", "--name"], phase="query").stdout
    if exact_name_is_present(names, DOMAIN_NAME):
        raise ContractError("runner domain appeared before definition")
    _require_ready_default_network(runner, network_uuid)
    payload["phase"] = "domain-define-intent"
    _atomic_write_manifest(manifest_path, payload)
    runner.run(["/usr/bin/virsh", "--connect", "qemu:///system", "define", str(domain_stage), "--validate"], phase="mutation")
    observed_uuid = runner.run(["/usr/bin/virsh", "--connect", "qemu:///system", "domuuid", DOMAIN_NAME], phase="query").stdout.strip()
    if observed_uuid != domain_uuid:
        raise ContractError("defined domain UUID does not match generated definition")
    inactive = runner.run(["/usr/bin/virsh", "--connect", "qemu:///system", "dumpxml", DOMAIN_NAME, "--inactive"], phase="query").stdout
    validate_domain_xml(inactive, "inactive", domain_uuid)
    payload["domain_uuid"] = domain_uuid
    payload["phase"] = "configuring-domain"
    _atomic_write_manifest(manifest_path, payload)
    runner.run(["/usr/bin/virsh", "--connect", "qemu:///system", "autostart", domain_uuid], phase="mutation")
    # Recheck UUID/config immediately before start.
    if runner.run(["/usr/bin/virsh", "--connect", "qemu:///system", "domuuid", DOMAIN_NAME], phase="query").stdout.strip() != domain_uuid:
        raise ContractError("domain UUID changed before start")
    validate_domain_xml(
        runner.run(["/usr/bin/virsh", "--connect", "qemu:///system", "dumpxml", DOMAIN_NAME, "--inactive"], phase="query").stdout,
        "inactive",
        domain_uuid,
    )
    _require_ready_default_network(runner, network_uuid)
    runner.run(["/usr/bin/virsh", "--connect", "qemu:///system", "start", domain_uuid], phase="mutation")
    live = runner.run(["/usr/bin/virsh", "--connect", "qemu:///system", "dumpxml", domain_uuid], phase="query").stdout
    validate_domain_xml(
        live,
        "live",
        domain_uuid,
        preflight_uid,
        preflight_gid,
    )
    parse_virsh_info(
        runner.run(
            ["/usr/bin/virsh", "--connect", "qemu:///system", "dominfo", domain_uuid],
            phase="query",
        ).stdout,
        "domain",
    )
    parse_inactive_block_list(
        runner.run(
            [
                "/usr/bin/virsh", "--connect", "qemu:///system", "domblklist",
                domain_uuid, "--inactive", "--details",
            ],
            phase="query",
        ).stdout
    )
    _verify_storage(runner, payload, True)
    payload["phase"] = "completed"
    _atomic_write_manifest(manifest_path, payload)


def _verify_storage(runner: CommandRunner, payload: Mapping[str, Any], running: bool) -> None:
    uid, gid = _qemu_identity(runner)
    disk_identity = _artifact_identity(Path(EXPECTED_DISK), uid, gid)
    seed_identity = _artifact_identity(Path(EXPECTED_SEED), uid, gid)
    for label, observed in (("disk_identity", disk_identity), ("seed_identity", seed_identity)):
        recorded = payload.get(label)
        if not isinstance(recorded, dict) or (recorded.get("device"), recorded.get("inode")) != (observed.device, observed.inode):
            raise ContractError(f"persistent {label} identity drift")
    info_command = ["/usr/bin/qemu-img", "info"]
    if running:
        info_command.append("--force-share")
    info_command.extend(["--output=json", EXPECTED_DISK])
    info = runner.run(info_command, phase="query").stdout
    parse_image_info(info, EXPECTED_DISK)
    seed_digest = _sha256_regular_file(Path(EXPECTED_SEED), 1024 * 1024 * 1024)
    if not hmac.compare_digest(seed_digest, str(payload.get("seed_sha256", ""))):
        raise ContractError("durable NoCloud seed content drift")
    runner.run(
        ["/usr/bin/setpriv", f"--reuid={uid}", f"--regid={gid}", "--clear-groups", "/usr/bin/test", "-r", EXPECTED_DISK],
        phase="query",
    )
    runner.run(
        ["/usr/bin/setpriv", f"--reuid={uid}", f"--regid={gid}", "--clear-groups", "/usr/bin/test", "-r", EXPECTED_SEED],
        phase="query",
    )
    if not running:
        runner.run(["/usr/bin/qemu-img", "check", EXPECTED_DISK], phase="image")


def main(argv: Sequence[str] | None = None) -> int:
    arguments = _parse_arguments(sys.argv[1:] if argv is None else argv)
    try:
        if arguments.command == "self-test-linux":
            _self_test_linux(arguments)
        elif arguments.command == "self-test-wrapper-timeout":
            _self_test_wrapper_timeout(arguments)
        elif arguments.command == "self-test-wrapper-spawn-boundary":
            _self_test_wrapper_spawn_boundary(arguments)
        else:
            _provision(arguments)
    except ContractError as exc:
        print(f"ERROR: {exc}", file=sys.stderr)
        return 1
    except (OSError, UnicodeError, subprocess.SubprocessError) as exc:
        print(f"ERROR: trusted provisioning system failure ({type(exc).__name__})", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
