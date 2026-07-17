#!/usr/bin/env bash
set -Eeuo pipefail
umask 077
export LC_ALL=C

readonly OWNER_LABEL_KEY="com.codestead.backup-production-e2e.owner"
readonly OWNER_PROJECT_LABEL_KEY="com.codestead.backup-production-e2e.project"
readonly PRODUCTION_COMPOSE_PROJECT="learncoding"
readonly -a REQUIRED_SERVICES=(
  app cloudflared exam-finalization-worker mail-worker migrate postgres
  practice-runner-recovery-worker project-review-correction-worker
  regrade-worker reward-worker
)
readonly -a REQUIRED_NETWORKS=(
  frontend mail-egress runner-egress github-egress data scanner signature-egress
)

fail() {
  printf 'backup production e2e: %s\n' "$*" >&2
  exit 1
}

require_command() {
  command -v "$1" >/dev/null 2>&1 \
    || fail "required command is unavailable"
}

single_line() {
  [[ -n "${1:-}" && "$1" != *$'\n'* && "$1" != *$'\r'* ]]
}

repository_state() {
  git -C "$1" status --porcelain=v1 --untracked-files=all \
    --ignored=matching --ignore-submodules=none
}

require_clean_repository() {
  local repository="$1"
  [[ -z "$(repository_state "$repository")" ]] \
    && git -C "$repository" diff --no-ext-diff --quiet -- \
    && git -C "$repository" diff --cached --no-ext-diff --quiet --
}

random_hex() {
  local byte_count="$1" value
  value="$(python3 -c \
    'import secrets,sys; sys.stdout.write(secrets.token_hex(int(sys.argv[1])))' \
    "$byte_count")" || return 1
  [[ "$value" =~ ^[0-9a-f]+$ ]] || return 1
  ((${#value} == byte_count * 2)) || return 1
  printf '%s\n' "$value"
}

write_random_hex_file() {
  local byte_count="$1" path="$2" value
  value="$(random_hex "$byte_count")" || return 1
  printf '%s\n' "$value" >"$path"
}

image_repo_digest() {
  local image="$1" repository="$2" candidate
  while IFS= read -r candidate; do
    if [[ "$candidate" == "$repository@sha256:"* \
      && "$candidate" =~ ^[^@,[:space:]]+@sha256:[0-9a-f]{64}$ ]]; then
      printf '%s\n' "$candidate"
      return 0
    fi
  done < <(docker image inspect --format \
    '{{range .RepoDigests}}{{println .}}{{end}}' "$image")
  return 1
}

docker_label_value() {
  docker inspect --format "{{ index .Config.Labels \"$2\" }}" "$1"
}

network_label_value() {
  docker network inspect --format "{{ index .Labels \"$2\" }}" "$1"
}

volume_label_value() {
  docker volume inspect --format "{{ index .Labels \"$2\" }}" "$1"
}

credential_probe_container_is_owned() {
  local id="${1:-}" pre_backup_container_ids="${pre_backup_container_ids:-}"
  local details full_id configured_image runtime_image path args entrypoint command
  local user working_dir extra isolation attach_stdout attach_stderr attach_stdin tty
  local auto_remove network_mode readonly_rootfs privileged pids_limit memory nano_cpus
  local cap_drop security_opt group_add tmpfs_value restart_name
  local owner_label owner_project_label image_owner_label image_project_label
  local compose_project compose_working_dir compose_service monitor_token monitor_phase
  local mount_listing mount_record mount_type mount_source mount_destination mount_rw
  local mount_extra output_source relative_output unexpected_mount=""
  local credential_mount_count=0 output_mount_count=0 tmpfs_mount_count=0
  local -a mount_records=()
  local expected_args='["--import","tsx","/app/scripts/backup/create-credential-probe.ts","/output/credential-probe.json","/run/secrets/credential_master_key"]'

  [[ "$id" =~ ^[0-9a-f]{64}$ \
    && -n "${test_root:-}" && -n "${operations_digest:-}" \
    && -n "${operations_image_id:-}" && -n "$pre_backup_container_ids" \
    && -f "$pre_backup_container_ids" && ! -L "$pre_backup_container_ids" \
    && -s "$pre_backup_container_ids" \
    && "$(stat -c '%a:%u' -- "$pre_backup_container_ids" 2>/dev/null)" \
      == "600:$(id -u)" ]] || return 1
  grep -Fxq -- "$id" "$pre_backup_container_ids" && return 1

  details="$(docker inspect --format \
    '{{.Id}}|{{.Config.Image}}|{{.Image}}|{{.Path}}|{{json .Args}}|{{json .Config.Entrypoint}}|{{json .Config.Cmd}}|{{.Config.User}}|{{.Config.WorkingDir}}' \
    "$id" 2>/dev/null)" || return 1
  IFS='|' read -r full_id configured_image runtime_image path args entrypoint command \
    user working_dir extra <<<"$details"
  [[ -z "${extra:-}" && "$full_id" == "$id" \
    && "$configured_image" == "${operations_digest:-}" \
    && "$runtime_image" == "${operations_image_id:-}" \
    && "$path" == node && "$args" == "$expected_args" \
    && "$entrypoint" == '["node"]' && "$command" == "$expected_args" \
    && "$user" == 1000:1000 && "$working_dir" == /app ]] || return 1

  isolation="$(docker inspect --format \
    '{{.Config.AttachStdout}}|{{.Config.AttachStderr}}|{{.Config.AttachStdin}}|{{.Config.Tty}}|{{.HostConfig.AutoRemove}}|{{.HostConfig.NetworkMode}}|{{.HostConfig.ReadonlyRootfs}}|{{.HostConfig.Privileged}}|{{.HostConfig.PidsLimit}}|{{.HostConfig.Memory}}|{{.HostConfig.NanoCpus}}|{{json .HostConfig.CapDrop}}|{{json .HostConfig.SecurityOpt}}|{{json .HostConfig.GroupAdd}}|{{index .HostConfig.Tmpfs "/tmp"}}|{{.HostConfig.RestartPolicy.Name}}' \
    "$id" 2>/dev/null)" || return 1
  IFS='|' read -r attach_stdout attach_stderr attach_stdin tty auto_remove \
    network_mode readonly_rootfs privileged pids_limit memory nano_cpus cap_drop \
    security_opt group_add tmpfs_value restart_name extra <<<"$isolation"
  [[ -z "${extra:-}" && "$attach_stdout" == true && "$attach_stderr" == true \
    && "$attach_stdin" == false && "$tty" == false && "$auto_remove" == true \
    && "$network_mode" == none && "$readonly_rootfs" == true \
    && "$privileged" == false && "$pids_limit" == 64 \
    && "$memory" == 268435456 && "$nano_cpus" == 500000000 \
    && "$cap_drop" == '["ALL"]' \
    && ( "$security_opt" == '["no-new-privileges"]' \
      || "$security_opt" == '["no-new-privileges=true"]' ) \
    && "$group_add" == '["2000"]' \
    && "$tmpfs_value" == rw,noexec,nosuid,nodev,size=16m \
    && "$restart_name" == no ]] || return 1

  owner_label="$(docker_label_value "$id" "$OWNER_LABEL_KEY" 2>/dev/null)" \
    || return 1
  owner_project_label="$(docker_label_value \
    "$id" "$OWNER_PROJECT_LABEL_KEY" 2>/dev/null)" || return 1
  compose_project="$(docker_label_value \
    "$id" com.docker.compose.project 2>/dev/null)" || return 1
  compose_working_dir="$(docker_label_value \
    "$id" com.docker.compose.project.working_dir 2>/dev/null)" || return 1
  compose_service="$(docker_label_value \
    "$id" com.docker.compose.service 2>/dev/null)" || return 1
  monitor_token="$(docker_label_value \
    "$id" com.codestead.backup.monitor.token 2>/dev/null)" || return 1
  monitor_phase="$(docker_label_value \
    "$id" com.codestead.backup.monitor.phase 2>/dev/null)" || return 1
  for label_variable in compose_project compose_working_dir compose_service \
    monitor_token monitor_phase; do
    [[ "${!label_variable}" != '<no value>' ]] \
      || printf -v "$label_variable" '%s' ''
  done
  [[ "$owner_label" == "${run_id:-}" \
    && "$owner_project_label" == "${ownership_project:-}" \
    && "$compose_project" == "" && "$compose_working_dir" == "" \
    && "$compose_service" == "" && "$monitor_token" == "" \
    && "$monitor_phase" == "" ]] || return 1

  image_owner_label="$(docker image inspect --format \
    "{{ index .Config.Labels \"$OWNER_LABEL_KEY\" }}" \
    "$runtime_image" 2>/dev/null)" || return 1
  image_project_label="$(docker image inspect --format \
    "{{ index .Config.Labels \"$OWNER_PROJECT_LABEL_KEY\" }}" \
    "$runtime_image" 2>/dev/null)" || return 1
  [[ "$image_owner_label" == "${run_id:-}" \
    && "$image_project_label" == "${ownership_project:-}" \
    && "$(docker image inspect --format '{{.Id}}' \
      "$configured_image" 2>/dev/null)" == "$runtime_image" ]] || return 1

  mount_listing="$(docker inspect --format \
    '{{range .Mounts}}{{printf "%s|%s|%s|%t\n" .Type .Source .Destination .RW}}{{end}}' \
    "$id" 2>/dev/null)" || return 1
  mapfile -t mount_records <<<"$mount_listing"
  for mount_record in "${mount_records[@]}"; do
    [[ -n "$mount_record" ]] || continue
    IFS='|' read -r mount_type mount_source mount_destination mount_rw mount_extra \
      <<<"$mount_record"
    if [[ -n "${mount_extra:-}" ]]; then
      unexpected_mount="$mount_record"
      break
    fi
    case "$mount_destination" in
      /run/secrets/credential_master_key)
        if [[ "$mount_type" == bind && "$mount_source" == "$test_root/config/secrets/credential_master_key" \
          && "$mount_rw" == false ]]; then
          credential_mount_count=$((credential_mount_count + 1))
        else
          unexpected_mount="$mount_record"
        fi
        ;;
      /output)
        if [[ "$mount_type" == bind && "$mount_rw" == true ]]; then
          output_source="$mount_source"
          output_mount_count=$((output_mount_count + 1))
        else
          unexpected_mount="$mount_record"
        fi
        ;;
      /tmp)
        if [[ "$mount_type" == tmpfs && -z "$mount_source" && "$mount_rw" == true ]]; then
          tmpfs_mount_count=$((tmpfs_mount_count + 1))
        else
          unexpected_mount="$mount_record"
        fi
        ;;
      *) unexpected_mount="$mount_record" ;;
    esac
    [[ -z "$unexpected_mount" ]] || break
  done
  [[ "$credential_mount_count" == 1 && "$output_mount_count" == 1 \
    && "$unexpected_mount" == "" && "$tmpfs_mount_count" -le 1 \
    && "$output_source" == "$test_root/staging/full."* ]] || return 1
  relative_output="${output_source#"$test_root/staging/full."}"
  [[ "$relative_output" =~ ^([0-9]{8}T[0-9]{6}Z)[.][A-Za-z0-9]{6}/probe-output$ ]] \
    || return 1
}

append_docker_query_lines() {
  local destination_name="$1" output line
  shift
  local -n destination="$destination_name"
  output="$("$@")" || return 1
  while IFS= read -r line; do
    [[ -n "$line" ]] && destination+=("$line")
  done <<<"$output"
}

docker_object_is_confirmed_absent() {
  local object_type="$1" object_id="$2" inventory
  local image_id repository tag digest extra
  docker info >/dev/null 2>&1 || return 1
  case "$object_type" in
    container)
      inventory="$(docker ps --all --quiet --no-trunc)" || return 1
      ;;
    network)
      inventory="$(docker network ls -q --no-trunc)" || return 1
      ;;
    volume)
      inventory="$(docker volume ls -q)" || return 1
      ;;
    image)
      inventory="$(docker image ls --all --digests --no-trunc \
        --format '{{.ID}}|{{.Repository}}|{{.Tag}}|{{.Digest}}')" \
        || return 1
      while IFS='|' read -r image_id repository tag digest extra; do
        [[ -n "$image_id" ]] || continue
        [[ -z "$extra" && "$image_id" == sha256:* \
          && -n "$repository" && -n "$tag" && -n "$digest" ]] || return 1
        [[ "$image_id" != "$object_id" ]] || return 1
        if [[ "$repository" != '<none>' && "$tag" != '<none>' \
          && "$repository:$tag" == "$object_id" ]]; then
          return 1
        fi
        if [[ "$repository" != '<none>' && "$digest" != '<none>' \
          && "$repository@$digest" == "$object_id" ]]; then
          return 1
        fi
      done <<<"$inventory"
      return 0
      ;;
    *) return 1 ;;
  esac
  ! grep -Fxq -- "$object_id" <<<"$inventory"
}

docker_query_is_empty() {
  local output
  output="$("$@")" || return 1
  [[ -z "$output" ]]
}

remove_owned_credential_probe_containers() {
  local id removal_failed=0
  local -a probe_candidates=()
  [[ -n "${operations_digest:-}" ]] || return 0
  command -v docker >/dev/null 2>&1 && docker info >/dev/null 2>&1 || return 1
  append_docker_query_lines probe_candidates docker ps --all --quiet --no-trunc \
    --filter "ancestor=$operations_digest" || return 1
  for id in "${probe_candidates[@]}"; do
    [[ -n "$id" ]] || continue
    credential_probe_container_is_owned "$id" || continue
    if ! docker rm --force "$id" >/dev/null 2>&1; then
      docker_object_is_confirmed_absent container "$id" || removal_failed=1
    fi
  done
  ((removal_failed == 0))
}

cleanup_test() {
  local original_status=$? cleanup_failed=0 id name label project_label image_label
  local monitor_details full_id configured_image runtime_image project working_dir
  local service monitor_name extra reference docker_cleanup_ready=0
  local -A seen_containers=() seen_networks=() seen_volumes=()
  local -a candidates=() monitor_candidates=() image_references=()
  trap - EXIT INT TERM
  set +e

  if command -v docker >/dev/null 2>&1 && docker info >/dev/null 2>&1; then
    docker_cleanup_ready=1
  else
    cleanup_failed=1
  fi

  if [[ -n "${container_ledger:-}" && -r "$container_ledger" ]]; then
    mapfile -t candidates <"$container_ledger"
  else
    candidates=()
  fi
  if ((docker_cleanup_ready == 1)) && [[ -n "${run_id:-}" ]]; then
    append_docker_query_lines candidates docker ps --all --quiet --no-trunc \
      --filter "label=$OWNER_LABEL_KEY=$run_id" || cleanup_failed=1
  fi
  if ((docker_cleanup_ready == 1)) && [[ -n "${operations_digest:-}" ]]; then
    append_docker_query_lines candidates docker ps --all --quiet --no-trunc \
      --filter "ancestor=$operations_digest" || cleanup_failed=1
  fi
  for id in "${candidates[@]}"; do
    [[ -n "$id" && -z "${seen_containers[$id]+x}" ]] || continue
    seen_containers[$id]=1
    if ! docker inspect "$id" >/dev/null 2>&1; then
      docker_object_is_confirmed_absent container "$id" || cleanup_failed=1
      continue
    fi
    label="$(docker_label_value "$id" "$OWNER_LABEL_KEY" 2>/dev/null)"
    project_label="$(docker_label_value \
      "$id" "$OWNER_PROJECT_LABEL_KEY" 2>/dev/null)"
    name="$(docker inspect --format '{{.Name}}' "$id" 2>/dev/null)"
    name="${name#/}"
    if [[ "$label" != "${run_id:-}" \
      || "$project_label" != "${ownership_project:-}" ]]; then
      cleanup_failed=1
      continue
    fi
    if [[ "$name" == "${resource_prefix:-}"-* ]]; then
      docker rm --force "$id" >/dev/null 2>&1 || cleanup_failed=1
    elif credential_probe_container_is_owned "$id"; then
      if ! docker rm --force "$id" >/dev/null 2>&1; then
        docker_object_is_confirmed_absent container "$id" || cleanup_failed=1
      fi
    else
      cleanup_failed=1
    fi
  done
  remove_owned_credential_probe_containers || cleanup_failed=1

  if ((docker_cleanup_ready == 1)) \
    && [[ -n "${repo_root:-}" && -n "${operations_image_id:-}" ]]; then
    append_docker_query_lines monitor_candidates docker ps --all --quiet --no-trunc \
      --filter "label=com.docker.compose.project=$PRODUCTION_COMPOSE_PROJECT" \
      --filter "label=com.docker.compose.project.working_dir=$repo_root" \
      --filter 'label=com.docker.compose.service=backup-monitor' \
      || cleanup_failed=1
    for id in "${monitor_candidates[@]}"; do
      [[ -n "$id" ]] || continue
      monitor_details="$(docker inspect --format \
        '{{.Id}}|{{.Config.Image}}|{{.Image}}|{{ index .Config.Labels "com.docker.compose.project" }}|{{ index .Config.Labels "com.docker.compose.project.working_dir" }}|{{ index .Config.Labels "com.docker.compose.service" }}|{{.Name}}' \
        "$id" 2>/dev/null)" || {
          cleanup_failed=1
          continue
        }
      IFS='|' read -r full_id configured_image runtime_image project working_dir \
        service monitor_name extra <<<"$monitor_details"
      if [[ -n "${extra:-}" || "$full_id" != "$id" \
        || "$configured_image" != "${operations_digest:-}" \
        || "$runtime_image" != "$operations_image_id" \
        || "$project" != "$PRODUCTION_COMPOSE_PROJECT" \
        || "$working_dir" != "$repo_root" || "$service" != backup-monitor \
        || ! "$monitor_name" =~ ^/codestead-backup-monitor- ]]; then
        cleanup_failed=1
        continue
      fi
      if [[ "$(docker image inspect --format \
        "{{ index .Config.Labels \"$OWNER_LABEL_KEY\" }}" \
        "$runtime_image" 2>/dev/null)" != "${run_id:-}" \
        || "$(docker image inspect --format \
        "{{ index .Config.Labels \"$OWNER_PROJECT_LABEL_KEY\" }}" \
        "$runtime_image" 2>/dev/null)" != "${ownership_project:-}" ]]; then
        cleanup_failed=1
        continue
      fi
      docker rm --force "$full_id" >/dev/null 2>&1 || cleanup_failed=1
    done
  fi

  candidates=()
  if [[ -n "${network_ledger:-}" && -r "$network_ledger" ]]; then
    mapfile -t candidates <"$network_ledger"
  fi
  if ((docker_cleanup_ready == 1)) && [[ -n "${run_id:-}" ]]; then
    append_docker_query_lines candidates docker network ls -q --no-trunc \
      --filter "label=$OWNER_LABEL_KEY=$run_id" || cleanup_failed=1
  fi
  for id in "${candidates[@]}"; do
    [[ -n "$id" && -z "${seen_networks[$id]+x}" ]] || continue
    seen_networks[$id]=1
    if ! docker network inspect "$id" >/dev/null 2>&1; then
      docker_object_is_confirmed_absent network "$id" || cleanup_failed=1
      continue
    fi
    label="$(network_label_value "$id" "$OWNER_LABEL_KEY" 2>/dev/null)"
    project_label="$(network_label_value \
      "$id" "$OWNER_PROJECT_LABEL_KEY" 2>/dev/null)"
    name="$(docker network inspect --format '{{.Name}}' "$id" 2>/dev/null)"
    if [[ "$label" != "${run_id:-}" \
      || "$project_label" != "${ownership_project:-}" \
      || "$name" != "${resource_prefix:-}"-* ]]; then
      cleanup_failed=1
      continue
    fi
    docker network rm "$id" >/dev/null 2>&1 || cleanup_failed=1
  done

  candidates=()
  if [[ -n "${volume_ledger:-}" && -r "$volume_ledger" ]]; then
    mapfile -t candidates <"$volume_ledger"
  fi
  if ((docker_cleanup_ready == 1)) && [[ -n "${run_id:-}" ]]; then
    append_docker_query_lines candidates docker volume ls -q \
      --filter "label=$OWNER_LABEL_KEY=$run_id" || cleanup_failed=1
  fi
  for name in "${candidates[@]}"; do
    [[ -n "$name" && -z "${seen_volumes[$name]+x}" ]] || continue
    seen_volumes[$name]=1
    if ! docker volume inspect "$name" >/dev/null 2>&1; then
      docker_object_is_confirmed_absent volume "$name" || cleanup_failed=1
      continue
    fi
    label="$(volume_label_value "$name" "$OWNER_LABEL_KEY" 2>/dev/null)"
    project_label="$(volume_label_value \
      "$name" "$OWNER_PROJECT_LABEL_KEY" 2>/dev/null)"
    if [[ "$label" != "${run_id:-}" \
      || "$project_label" != "${ownership_project:-}" \
      || "$name" != "${resource_prefix:-}"-* ]]; then
      cleanup_failed=1
      continue
    fi
    docker volume rm "$name" >/dev/null 2>&1 || cleanup_failed=1
  done

  if [[ -n "${test_root:-}" && -d "$test_root" ]]; then
    if [[ -n "${toolbox_image:-}" ]] \
      && docker image inspect "$toolbox_image" >/dev/null 2>&1 \
      && [[ "$(docker image inspect --format \
        "{{ index .Config.Labels \"$OWNER_LABEL_KEY\" }}" \
        "$toolbox_image" 2>/dev/null)" == "${run_id:-}" \
        && "$(docker image inspect --format \
        "{{ index .Config.Labels \"$OWNER_PROJECT_LABEL_KEY\" }}" \
        "$toolbox_image" 2>/dev/null)" == "${ownership_project:-}" ]]; then
      docker run --rm --name "${resource_prefix}-filesystem-cleanup" \
        --label "$OWNER_LABEL_KEY=$run_id" \
        --label "$OWNER_PROJECT_LABEL_KEY=$ownership_project" \
        --network none --read-only --cap-drop ALL \
        --security-opt no-new-privileges --pids-limit 64 --memory 128m \
        --mount "type=bind,src=$test_root,dst=$test_root" \
        --entrypoint /bin/bash "$toolbox_image" -ceu \
        'root="$1"; [[ "$root" == /* && "$root" != / ]]; find -P "$root" -mindepth 1 -delete' \
        filesystem-cleanup "$test_root" >/dev/null 2>&1 \
        || cleanup_failed=1
    else
      find -P "$test_root" -mindepth 1 -delete >/dev/null 2>&1 \
        || cleanup_failed=1
    fi
  fi

  image_references=(
    "${operations_digest:-}" "${operations_tag:-}" "${toolbox_image:-}"
  )
  for reference in "${image_references[@]}"; do
    [[ -n "$reference" ]] || continue
    if ! docker image inspect "$reference" >/dev/null 2>&1; then
      docker_object_is_confirmed_absent image "$reference" || cleanup_failed=1
      continue
    fi
    image_label="$(docker image inspect --format \
      "{{ index .Config.Labels \"$OWNER_LABEL_KEY\" }}" \
      "$reference" 2>/dev/null)"
    project_label="$(docker image inspect --format \
      "{{ index .Config.Labels \"$OWNER_PROJECT_LABEL_KEY\" }}" \
      "$reference" 2>/dev/null)"
    if [[ "$image_label" != "${run_id:-}" \
      || "$project_label" != "${ownership_project:-}" ]]; then
      cleanup_failed=1
      continue
    fi
    docker image rm --no-prune "$reference" >/dev/null 2>&1 \
      || cleanup_failed=1
  done
  for id in "${operations_image_id:-}" "${toolbox_image_id:-}"; do
    [[ -n "$id" ]] || continue
    if docker image inspect "$id" >/dev/null 2>&1; then
      image_label="$(docker image inspect --format \
        "{{ index .Config.Labels \"$OWNER_LABEL_KEY\" }}" \
        "$id" 2>/dev/null)"
      project_label="$(docker image inspect --format \
        "{{ index .Config.Labels \"$OWNER_PROJECT_LABEL_KEY\" }}" \
        "$id" 2>/dev/null)"
      if [[ "$image_label" == "${run_id:-}" \
        && "$project_label" == "${ownership_project:-}" ]]; then
        docker image rm --no-prune "$id" >/dev/null 2>&1 \
          || cleanup_failed=1
      else
        cleanup_failed=1
      fi
    else
      docker_object_is_confirmed_absent image "$id" || cleanup_failed=1
    fi
  done

  if ! docker info >/dev/null 2>&1; then
    cleanup_failed=1
  else
    docker_query_is_empty docker ps -aq \
      --filter "label=$OWNER_LABEL_KEY=$run_id" || cleanup_failed=1
    docker_query_is_empty docker network ls -q --no-trunc \
      --filter "label=$OWNER_LABEL_KEY=$run_id" || cleanup_failed=1
    docker_query_is_empty docker volume ls -q \
      --filter "label=$OWNER_LABEL_KEY=$run_id" || cleanup_failed=1
    docker_query_is_empty docker image ls -aq \
      --filter "label=$OWNER_LABEL_KEY=$run_id" || cleanup_failed=1
    docker_query_is_empty docker ps -aq \
      --filter "label=$OWNER_PROJECT_LABEL_KEY=$ownership_project" \
      || cleanup_failed=1
    docker_query_is_empty docker network ls -q --no-trunc \
      --filter "label=$OWNER_PROJECT_LABEL_KEY=$ownership_project" \
      || cleanup_failed=1
    docker_query_is_empty docker volume ls -q \
      --filter "label=$OWNER_PROJECT_LABEL_KEY=$ownership_project" \
      || cleanup_failed=1
    docker_query_is_empty docker image ls -aq \
      --filter "label=$OWNER_PROJECT_LABEL_KEY=$ownership_project" \
      || cleanup_failed=1
    docker_query_is_empty docker ps -aq \
      --filter "label=com.docker.compose.project=$PRODUCTION_COMPOSE_PROJECT" \
      --filter "label=com.docker.compose.project.working_dir=$repo_root" \
      || cleanup_failed=1
    docker_query_is_empty docker network ls -q --no-trunc \
      --filter "label=com.docker.compose.project=$PRODUCTION_COMPOSE_PROJECT" \
      || cleanup_failed=1
  fi
  if [[ -n "${test_root:-}" && -d "$test_root" ]]; then
    rmdir -- "$test_root" >/dev/null 2>&1 || cleanup_failed=1
  fi
  if [[ -n "${repo_root:-}" ]]; then
    require_clean_repository "$repo_root" || cleanup_failed=1
  fi

  if ((original_status != 0 || cleanup_failed != 0 \
    || ${inner_complete:-0} != 1)); then
    printf 'backup production e2e: test or exact cleanup failed\n' >&2
    exit 1
  fi
  printf '%s\n' backup-production-e2e-tests-ok
}

assert_cleanup_rejects_docker_loss() {
  local runner_root="$1" self_test_root self_test_output self_test_status=0
  self_test_root="$(mktemp -d -- "$runner_root/codestead-cleanup-loss.XXXXXX")" \
    || fail "Docker-loss cleanup proof root could not be created"
  self_test_output="$(
    (
      docker() { return 1; }
      test_root="$self_test_root"
      run_id=11111111111111111111111111111111
      ownership_project=codestead-cleanup-loss-proof
      resource_prefix=codestead-cleanup-loss-proof
      repo_root=""
      inner_complete=1
      operations_digest=""
      operations_tag=""
      operations_image_id=""
      toolbox_image=""
      toolbox_image_id=""
      container_ledger="$self_test_root/containers"
      network_ledger="$self_test_root/networks"
      volume_ledger="$self_test_root/volumes"
      : >"$container_ledger"
      : >"$network_ledger"
      : >"$volume_ledger"
      cleanup_test
    ) 2>&1
  )" || self_test_status=$?
  [[ "$self_test_status" == 1 \
    && "$self_test_output" == *'test or exact cleanup failed'* \
    && "$self_test_output" != *backup-production-e2e-tests-ok* \
    && ! -e "$self_test_root" ]] \
    || fail "cleanup did not fail closed when Docker became unreachable"
}

run_inner() {
  local test_root="$BACKUP_E2E_ROOT" repo_root="$BACKUP_E2E_REPO_ROOT"
  local run_id="$BACKUP_E2E_RUN_ID" resource_prefix="$BACKUP_E2E_RESOURCE_PREFIX"
  local ownership_project="$BACKUP_E2E_OWNERSHIP_PROJECT"
  local operations_digest="$BACKUP_E2E_OPERATIONS_DIGEST"
  local postgres_digest="$BACKUP_E2E_POSTGRES_DIGEST"
  local cloudflared_digest="$BACKUP_E2E_CLOUDFLARED_DIGEST"
  local container_ledger="$BACKUP_E2E_CONTAINER_LEDGER"
  local network_ledger="$BACKUP_E2E_NETWORK_LEDGER"
  local volume_ledger="$BACKUP_E2E_VOLUME_LEDGER"
  local pre_backup_container_ids="$BACKUP_E2E_PRE_BACKUP_CONTAINER_IDS"
  local completion_file="$BACKUP_E2E_COMPLETION_FILE"
  local token_file="$BACKUP_E2E_TOKEN_FILE"
  local inner_token="$BACKUP_E2E_INNER_TOKEN"
  local config_root="$test_root/config" secrets_root="$test_root/config/secrets"
  local learn_data_root="$test_root/learn-data" backup_root="$test_root/backup-root"
  local stage_root="$test_root/staging" ephemeral_root="$test_root/ephemeral"
  local lock_root="$test_root/locks" verify_root="$test_root/verified"
  local app_extract_root="$test_root/app-extracted"
  local docker_config_root="$test_root/docker-config" home_root="$test_root/home"
  local tmp_root="$test_root/tmp"
  local compose_env="$config_root/compose.env"
  local compose_override="$config_root/compose.override.yaml"
  local backup_config="$config_root/backup.env"
  local age_identity="$config_root/offline-age-identity.txt"
  local age_recipient="$config_root/backup-age-recipient.txt"
  local controller_log="$test_root/controller.log"
  local expected_images="$test_root/expected-images"
  local postgres_password database_url credential_master_key db_sentinel
  local app_sentinel migration_hash migration_created_at migration_state_hash
  local cloudflare_account cloudflare_secret cloudflare_tunnel
  local git_commit postgres_id restore_database archive checksum marker actual_hash
  local sidecar_hash sidecar_name sidecar_extra completed_utc marker_archive marker_hash
  local verify_result restored_value original_value data_checksums database_version
  local secret_file secret_line
  local service id details full_id running status health project working_dir service_label
  local extra network_id network_name manifest actual_images
  local -a archives=() checksums=() marker_lines=() running_services=()

  [[ $# -eq 1 && "$1" == --inside-toolbox ]] || fail "invalid inner invocation"
  [[ "$(uname -s)" == Linux && "$(id -u)" == 0 ]] \
    || fail "inner controller is not root on Linux"
  [[ "${CODESTEAD_DISPOSABLE_HOST:-}" == 1 \
    && "${GITHUB_ACTIONS:-}" == true \
    && "${RUNNER_ENVIRONMENT:-}" == github-hosted ]] \
    || fail "inner disposable GitHub-hosted acknowledgement is absent"
  for value in "$test_root" "$repo_root" "$container_ledger" "$network_ledger" \
    "$volume_ledger" "$pre_backup_container_ids" "$completion_file" "$token_file"; do
    [[ "$value" == /* ]] || fail "inner path is not absolute"
    single_line "$value" || fail "inner path is ambiguous"
  done
  [[ -d "$test_root" && ! -L "$test_root" \
    && "$(stat -c '%a' -- "$test_root")" == 700 ]] \
    || fail "isolated root is unsafe"
  [[ -f "$token_file" && ! -L "$token_file" \
    && "$(<"$token_file")" == "$inner_token" ]] \
    || fail "inner ownership token is invalid"
  install -d -m 0700 "$docker_config_root" "$home_root" "$tmp_root"
  export DOCKER_CONFIG="$docker_config_root"
  unset DOCKER_CONTEXT DOCKER_TLS_VERIFY DOCKER_CERT_PATH BUILDKIT_HOST \
    BUILDX_BUILDER BUILDX_CONFIG
  export DOCKER_HOST=unix:///var/run/docker.sock
  export HOME="$home_root"
  export TMPDIR="$tmp_root"
  export GIT_CONFIG_GLOBAL="$home_root/.gitconfig"
  export GIT_CONFIG_NOSYSTEM=1
  export GIT_OPTIONAL_LOCKS=0
  git config --file "$GIT_CONFIG_GLOBAL" --add safe.directory "$repo_root" \
    || fail "isolated Git ownership configuration failed"
  chmod 0600 "$GIT_CONFIG_GLOBAL"
  [[ "$(realpath -e -- "$repo_root")" == "$repo_root" \
    && "$(git -C "$repo_root" rev-parse --show-toplevel)" == "$repo_root" ]] \
    || fail "repository mount is not the exact worktree"
  case ",$(findmnt -n -o OPTIONS -T "$repo_root")," in
    *,ro,*) ;;
    *) fail "repository mount is not read-only" ;;
  esac
  [[ -S /var/run/docker.sock ]] || fail "Docker socket is unavailable"
  for command_name in age age-keygen bash cmp diff docker find findmnt git grep \
    gzip hostname python3 realpath sha256sum stat tar; do
    require_command "$command_name"
  done
  docker info >/dev/null 2>&1 || fail "Docker daemon is unreachable"
  docker compose version >/dev/null 2>&1 || fail "Docker Compose CLI is unavailable"
  require_clean_repository "$repo_root" || fail "repository changed before inner run"
  [[ "$operations_digest" =~ ^[^@,[:space:]]+@sha256:[0-9a-f]{64}$ \
    && "$postgres_digest" =~ ^postgres@sha256:[0-9a-f]{64}$ \
    && "$cloudflared_digest" =~ ^cloudflare/cloudflared@sha256:[0-9a-f]{64}$ ]] \
    || fail "immutable image references are invalid"
  [[ "$(docker image inspect --format '{{.Id}}' "$operations_digest")" \
    =~ ^sha256:[0-9a-f]{64}$ ]] || fail "operations digest is not locally usable"

  install -d -m 0700 "$config_root" "$secrets_root" "$docker_config_root" \
    "$home_root" "$tmp_root" "$learn_data_root" \
    "$learn_data_root/postgres" "$learn_data_root/next-cache" \
    "$learn_data_root/app-data" "$backup_root" "$backup_root/full" \
    "$backup_root/state" "$stage_root" "$ephemeral_root" "$verify_root" \
    "$app_extract_root"
  install -d -m 0755 "$lock_root"
  printf '%s\n' LEARNCODING_BACKUP_V1 >"$backup_root/.learncoding-backup-root"
  chmod 0600 "$backup_root/.learncoding-backup-root"

  postgres_password="$(random_hex 24)" || fail "random password generation failed"
  db_sentinel="$(random_hex 24)" || fail "database sentinel generation failed"
  app_sentinel="$(random_hex 24)" || fail "application sentinel generation failed"
  credential_master_key="$(python3 -c \
    'import base64,secrets,sys; sys.stdout.write(base64.b64encode(secrets.token_bytes(32)).decode("ascii"))')" \
    || fail "credential master key generation failed"
  [[ "$credential_master_key" =~ ^[A-Za-z0-9+/]{43}=$ ]] \
    || fail "credential master key shape is invalid"
  database_url="postgresql://learncoding:${postgres_password}@postgres:5432/learncoding"

  printf '%s\n' "$postgres_password" >"$secrets_root/postgres_password"
  printf '%s\n' "$database_url" >"$secrets_root/database_url"
  write_random_hex_file 32 "$secrets_root/better_auth_secret" \
    || fail "secret fixture generation failed"
  write_random_hex_file 32 "$secrets_root/bootstrap_admin_password" \
    || fail "secret fixture generation failed"
  write_random_hex_file 32 "$secrets_root/lost_device_proof_key" \
    || fail "secret fixture generation failed"
  write_random_hex_file 32 "$secrets_root/deletion_tombstone_key" \
    || fail "secret fixture generation failed"
  printf '%s\n' "$credential_master_key" >"$secrets_root/credential_master_key"
  write_random_hex_file 32 "$secrets_root/google_client_secret" \
    || fail "secret fixture generation failed"
  write_random_hex_file 32 "$secrets_root/runner_shared_secret" \
    || fail "secret fixture generation failed"
  write_random_hex_file 16 "$secrets_root/gmail_client_id" \
    || fail "secret fixture generation failed"
  write_random_hex_file 32 "$secrets_root/gmail_client_secret" \
    || fail "secret fixture generation failed"
  write_random_hex_file 32 "$secrets_root/gmail_refresh_token" \
    || fail "secret fixture generation failed"
  cloudflare_account="$(random_hex 16)" \
    || fail "Cloudflare fixture generation failed"
  cloudflare_secret="$(random_hex 32)" \
    || fail "Cloudflare fixture generation failed"
  cloudflare_tunnel="$(random_hex 16)" \
    || fail "Cloudflare fixture generation failed"
  printf '{"AccountTag":"%s","TunnelSecret":"%s","TunnelID":"%s"}\n' \
    "$cloudflare_account" "$cloudflare_secret" "$cloudflare_tunnel" \
    >"$secrets_root/cloudflare_tunnel_credentials.json"
  chown -R 0:2000 "$secrets_root"
  find "$secrets_root" -mindepth 1 -maxdepth 1 -type f -exec chmod 0440 {} +
  chmod 0700 "$secrets_root"

  if ! age-keygen -o "$age_identity" >/dev/null 2>&1; then
    fail "offline age identity generation failed"
  fi
  age-keygen -y "$age_identity" >"$age_recipient" 2>/dev/null \
    || fail "offline age recipient generation failed"
  chmod 0600 "$age_identity" "$age_recipient"
  printf '%s\n' "$app_sentinel" >"$learn_data_root/app-data/e2e-sentinel.txt"
  chmod 0600 "$learn_data_root/app-data/e2e-sentinel.txt"

  cat >"$config_root/cloudflared.yml" <<EOF
tunnel: backup-production-e2e
credentials-file: /run/secrets/cloudflare_tunnel_credentials
ingress:
  - service: http_status:404
EOF
  chmod 0440 "$config_root/cloudflared.yml"

  cat >"$compose_env" <<EOF
APP_NAME=Codestead Backup E2E
APP_URL=https://backup-e2e.invalid
SOURCE_CODE_URL=https://backup-e2e.invalid/source
APP_RUNTIME_IMAGE=$operations_digest
APP_TOOLING_IMAGE=$operations_digest
APP_WORKER_IMAGE=$operations_digest
APP_REGRADE_WORKER_IMAGE=$operations_digest
APP_PROJECT_REVIEW_WORKER_IMAGE=$operations_digest
APP_SCANNER_WORKER_IMAGE=$operations_digest
APP_OPERATIONS_IMAGE=$operations_digest
DEPLOY_PLATFORM=linux/amd64
UPLOADS_ENABLED=false
COMPOSE_PROFILES=
SECRETS_GID=2000
LEARN_DATA_ROOT=$learn_data_root
SECRETS_DIR=$secrets_root
CLOUDFLARE_CONFIG_FILE=$config_root/cloudflared.yml
POSTGRES_IMAGE=$postgres_digest
CLOUDFLARED_IMAGE=$cloudflared_digest
CLAMAV_IMAGE=$operations_digest
POSTGRES_DB=learncoding
POSTGRES_USER=learncoding
RUNNER_BASE_URL=http://127.0.0.1:4100
GOOGLE_CLIENT_ID=
BOOTSTRAP_ADMIN_EMAIL=
MAIL_ADAPTER=outbox
MAIL_FROM=
OUTBOX_POLL_SECONDS=60
REGRADE_POLL_SECONDS=10
REGRADE_BATCH_SIZE=2
PRACTICE_RECOVERY_POLL_SECONDS=5
PRACTICE_RECOVERY_BATCH_SIZE=2
CLAMD_TIMEOUT_SECONDS=120
UPLOAD_SCAN_POLL_SECONDS=10
UPLOAD_SCAN_BATCH_SIZE=10
UPLOAD_SCAN_LEASE_SECONDS=180
UPLOAD_SCAN_MAX_ATTEMPTS=8
UPLOAD_SCAN_RETRY_BASE_SECONDS=5
UPLOAD_SCAN_RETRY_MAX_SECONDS=900
LOG_LEVEL=info
SENTRY_DSN=
EOF
  chmod 0640 "$compose_env"

  cat >"$backup_config" <<EOF
REPO_ROOT=$repo_root
COMPOSE_ENV_FILE=$compose_env
LEARN_DATA_ROOT=$learn_data_root
BACKUP_ROOT=$backup_root
BACKUP_STAGE_ROOT=$stage_root
BACKUP_EPHEMERAL_ROOT=$ephemeral_root
BACKUP_LOCK_FILE=$lock_root/backup.lock
AGE_RECIPIENT_FILE=$age_recipient
CREDENTIAL_MASTER_KEY_FILE=$secrets_root/credential_master_key
MAX_BACKUP_AGE_HOURS=36
FILESYSTEM_WARN_PERCENT=70
FILESYSTEM_CRITICAL_PERCENT=85
CHECKSUM_SAMPLE_COUNT=1
ALERT_HOOK=$config_root/nonexistent-alert-hook
ENABLE_RCLONE_OFFSITE=0
CHECK_OFFSITE=0
EOF
  chmod 0600 "$backup_config"

  {
    printf 'services:\n'
    for service in "${REQUIRED_SERVICES[@]}"; do
      printf '  %s:\n' "$service"
      printf '    container_name: "%s-%s"\n' "$resource_prefix" "$service"
      printf '    labels:\n'
      printf '      "%s": "%s"\n' "$OWNER_LABEL_KEY" "$run_id"
      printf '      "%s": "%s"\n' "$OWNER_PROJECT_LABEL_KEY" "$ownership_project"
    done
    printf 'networks:\n'
    for network_name in "${REQUIRED_NETWORKS[@]}"; do
      printf '  %s:\n' "$network_name"
      printf '    name: "%s-%s"\n' "$resource_prefix" "$network_name"
      printf '    labels:\n'
      printf '      "%s": "%s"\n' "$OWNER_LABEL_KEY" "$run_id"
      printf '      "%s": "%s"\n' "$OWNER_PROJECT_LABEL_KEY" "$ownership_project"
    done
    printf 'volumes:\n'
    printf '  clamav-signatures:\n'
    printf '    name: "%s-clamav-signatures"\n' "$resource_prefix"
    printf '    labels:\n'
    printf '      "%s": "%s"\n' "$OWNER_LABEL_KEY" "$run_id"
    printf '      "%s": "%s"\n' "$OWNER_PROJECT_LABEL_KEY" "$ownership_project"
  } >"$compose_override"
  chmod 0600 "$compose_override"

  unset COMPOSE_FILE COMPOSE_PROJECT_NAME COMPOSE_PROFILES
  docker compose --project-directory "$repo_root" --env-file "$compose_env" \
    -f "$repo_root/compose.yaml" -f "$compose_override" config --quiet \
    >/dev/null 2>&1 || fail "generated Compose contract is invalid"
  docker compose --project-directory "$repo_root" --env-file "$compose_env" \
    -f "$repo_root/compose.yaml" -f "$compose_override" \
    create --no-build --pull never "${REQUIRED_SERVICES[@]}" \
    >/dev/null 2>&1 || fail "required Compose containers were not created"

  : >"$expected_images"
  chmod 0600 "$expected_images"
  for service in "${REQUIRED_SERVICES[@]}"; do
    id="$(docker compose --project-directory "$repo_root" \
      --env-file "$compose_env" -f "$repo_root/compose.yaml" \
      -f "$compose_override" ps --all --quiet --no-trunc "$service")" \
      || fail "Compose container lookup failed"
    [[ "$id" =~ ^[0-9a-f]{64}$ ]] || fail "Compose service identity is invalid"
    details="$(docker inspect --format \
      '{{.Id}}|{{.State.Running}}|{{.State.Status}}|{{ index .Config.Labels "com.docker.compose.project" }}|{{ index .Config.Labels "com.docker.compose.project.working_dir" }}|{{ index .Config.Labels "com.docker.compose.service" }}|{{ index .Config.Labels "com.codestead.backup-production-e2e.owner" }}|{{ index .Config.Labels "com.codestead.backup-production-e2e.project" }}|{{.Name}}|{{.Image}}' \
      "$id")" || fail "Compose container inspection failed"
    IFS='|' read -r full_id running status project working_dir service_label \
      owner_label owner_project_label container_name image_id extra <<<"$details"
    [[ -z "${extra:-}" && "$full_id" == "$id" && "$running" == false \
      && "$status" == created && "$project" == "$PRODUCTION_COMPOSE_PROJECT" \
      && "$working_dir" == "$repo_root" && "$service_label" == "$service" \
      && "$owner_label" == "$run_id" \
      && "$owner_project_label" == "$ownership_project" \
      && "$container_name" == "/$resource_prefix-$service" \
      && "$image_id" =~ ^sha256:[0-9a-f]{64}$ ]] \
      || fail "created Compose container ownership or state is invalid"
    printf '%s\n' "$full_id" >>"$container_ledger"
    printf 'image_id.%s=%s\n' "$service" "$image_id" >>"$expected_images"
  done
  sort -o "$expected_images" "$expected_images"

  while IFS= read -r network_id; do
    [[ -n "$network_id" ]] || continue
    network_name="$(docker network inspect --format '{{.Name}}' "$network_id")" \
      || fail "owned network inspection failed"
    [[ "$(network_label_value "$network_id" "$OWNER_LABEL_KEY")" == "$run_id" \
      && "$(network_label_value "$network_id" "$OWNER_PROJECT_LABEL_KEY")" \
        == "$ownership_project" \
      && "$network_name" == "$resource_prefix-"* ]] \
      || fail "created network ownership is invalid"
    printf '%s\n' "$network_id" >>"$network_ledger"
  done < <(docker network ls -q --no-trunc \
    --filter "label=$OWNER_LABEL_KEY=$run_id")
  while IFS= read -r volume_name; do
    [[ -n "$volume_name" ]] || continue
    [[ "$(volume_label_value "$volume_name" "$OWNER_LABEL_KEY")" == "$run_id" \
      && "$(volume_label_value "$volume_name" "$OWNER_PROJECT_LABEL_KEY")" \
        == "$ownership_project" \
      && "$volume_name" == "$resource_prefix-"* ]] \
      || fail "created volume ownership is invalid"
    printf '%s\n' "$volume_name" >>"$volume_ledger"
  done < <(docker volume ls -q --filter "label=$OWNER_LABEL_KEY=$run_id")
  [[ ! -s "$volume_ledger" ]] \
    || fail "disabled upload profile created an unexpected volume"

  postgres_id="$(docker compose --project-directory "$repo_root" \
    --env-file "$compose_env" -f "$repo_root/compose.yaml" \
    -f "$compose_override" ps --all --quiet --no-trunc postgres)" \
    || fail "PostgreSQL container lookup failed"
  docker compose --project-directory "$repo_root" --env-file "$compose_env" \
    -f "$repo_root/compose.yaml" -f "$compose_override" start postgres \
    >/dev/null 2>&1 || fail "PostgreSQL did not start"
  health=""
  for _ in {1..90}; do
    health="$(docker inspect --format '{{if .State.Health}}{{.State.Health.Status}}{{end}}' \
      "$postgres_id" 2>/dev/null)"
    [[ "$health" != healthy ]] || break
    sleep 2
  done
  [[ "$health" == healthy ]] || fail "PostgreSQL did not become healthy"

  mapfile -t running_services < <(docker compose --env-file "$compose_env" \
    -f "$repo_root/compose.yaml" ps --status running --services)
  [[ ${#running_services[@]} -eq 1 && "${running_services[0]}" == postgres ]] \
    || fail "a service other than PostgreSQL is running"
  for service in "${REQUIRED_SERVICES[@]}"; do
    [[ "$service" == postgres ]] && continue
    id="$(docker compose --env-file "$compose_env" -f "$repo_root/compose.yaml" \
      ps --all --quiet --no-trunc "$service")" \
      || fail "stopped service lookup failed"
    [[ -n "$id" \
      && "$(docker inspect --format '{{.State.Status}}' "$id")" == created ]] \
      || fail "a required non-PostgreSQL service is not created and stopped"
  done

  data_checksums="$(docker exec "$postgres_id" psql --username=learncoding \
    --dbname=learncoding --no-psqlrc --quiet --tuples-only --no-align \
    --set=ON_ERROR_STOP=1 --command='SHOW data_checksums')" \
    || fail "PostgreSQL checksum query failed"
  [[ "$data_checksums" == on ]] || fail "PostgreSQL data checksums are disabled"
  database_version="$(docker exec "$postgres_id" postgres --version)" \
    || fail "PostgreSQL version query failed"
  [[ "$database_version" =~ ^postgres[[:space:]]+\(PostgreSQL\)[[:space:]]+17([.][0-9]+)? ]] \
    || fail "PostgreSQL major version is not 17"

  migration_hash="$(printf '%s' "migration-$run_id" | sha256sum)"
  migration_hash="${migration_hash%% *}"
  migration_created_at="$(date -u +%s)000"
  [[ "$migration_hash" =~ ^[0-9a-f]{64}$ \
    && "$migration_created_at" =~ ^[0-9]{13}$ ]] \
    || fail "migration fixture metadata is invalid"
  if ! docker exec -i "$postgres_id" psql --username=learncoding \
    --dbname=learncoding --no-psqlrc --quiet --set=ON_ERROR_STOP=1 \
    >/dev/null 2>&1 <<EOF
CREATE SCHEMA drizzle;
CREATE TABLE drizzle.__drizzle_migrations (
  id bigint PRIMARY KEY,
  hash text NOT NULL,
  created_at bigint NOT NULL
);
INSERT INTO drizzle.__drizzle_migrations (id, hash, created_at)
VALUES (1, '$migration_hash', $migration_created_at);
CREATE TABLE public.backup_e2e_sentinel (
  id integer PRIMARY KEY,
  value text NOT NULL
);
INSERT INTO public.backup_e2e_sentinel (id, value)
VALUES (1, '$db_sentinel');
EOF
  then
    fail "PostgreSQL fixture initialization failed"
  fi
  original_value="$(docker exec "$postgres_id" psql --username=learncoding \
    --dbname=learncoding --no-psqlrc --quiet --tuples-only --no-align \
    --set=ON_ERROR_STOP=1 \
    --command='SELECT value FROM public.backup_e2e_sentinel WHERE id = 1')" \
    || fail "database sentinel query failed"
  [[ "$original_value" == "$db_sentinel" ]] \
    || fail "database sentinel was not initialized"
  migration_state_hash="$(printf '%s|%s|%s\n' 1 "$migration_hash" \
    "$migration_created_at" | sha256sum)"
  migration_state_hash="${migration_state_hash%% *}"
  git_commit="$(git -C "$repo_root" rev-parse --verify HEAD)" \
    || fail "Git commit lookup failed"

  docker ps --all --quiet --no-trunc | sort >"$pre_backup_container_ids" \
    || fail "pre-backup container snapshot failed"
  chmod 0600 "$pre_backup_container_ids"
  sync -f "$pre_backup_container_ids" \
    || fail "pre-backup container snapshot sync failed"
  [[ -s "$pre_backup_container_ids" && ! -L "$pre_backup_container_ids" ]] \
    || fail "pre-backup container snapshot is unsafe"
  while IFS= read -r id; do
    [[ "$id" =~ ^[0-9a-f]{64}$ ]] \
      || fail "pre-backup container snapshot contains an invalid ID"
  done <"$pre_backup_container_ids"

  set +e
  BACKUP_CONFIG_FILE="$backup_config" \
    bash "$repo_root/scripts/backup/backup.sh" >"$controller_log" 2>&1
  controller_status=$?
  set -e
  [[ "$controller_status" -eq 0 ]] || fail "production backup controller failed"
  for secret_value in "$postgres_password" "$database_url" "$credential_master_key" \
    "$cloudflare_account" "$cloudflare_secret" "$cloudflare_tunnel" \
    "$db_sentinel" "$app_sentinel"; do
    if grep -Fq -- "$secret_value" "$controller_log"; then
      fail "production backup controller printed generated secret material"
    fi
  done
  for secret_file in "$secrets_root"/*; do
    while IFS= read -r secret_line || [[ -n "$secret_line" ]]; do
      [[ -n "$secret_line" ]] || continue
      if grep -Fq -- "$secret_line" "$controller_log"; then
        fail "production backup controller printed generated secret material"
      fi
    done <"$secret_file"
  done
  if grep -Fq 'AGE-SECRET-KEY-' "$controller_log"; then
    fail "production backup controller printed age identity material"
  fi

  mapfile -t archives < <(find "$backup_root/full" -maxdepth 1 -type f \
    -name 'learncoding-full-*.tar.gz.age' -print)
  mapfile -t checksums < <(find "$backup_root/full" -maxdepth 1 -type f \
    -name 'learncoding-full-*.tar.gz.age.sha256' -print)
  [[ ${#archives[@]} -eq 1 && ${#checksums[@]} -eq 1 \
    && "$(find "$backup_root/full" -mindepth 1 -maxdepth 1 -print \
      | wc -l | tr -d ' ')" == 2 ]] \
    || fail "published recovery point cardinality is invalid"
  archive="${archives[0]}"
  checksum="${checksums[0]}"
  [[ -f "$archive" && ! -L "$archive" \
    && -f "$checksum" && ! -L "$checksum" \
    && "$checksum" == "${archive}.sha256" \
    && "$(basename -- "$archive")" \
      =~ ^learncoding-full-[0-9]{8}T[0-9]{6}Z[.]tar[.]gz[.]age$ ]] \
    || fail "published recovery point names are invalid"
  [[ "$(stat -c '%a' -- "$archive")" == 600 \
    && "$(stat -c '%a' -- "$checksum")" == 600 \
    && "$(stat -c '%u' -- "$archive")" == 0 \
    && "$(stat -c '%u' -- "$checksum")" == 0 ]] \
    || fail "archive or checksum mode is not 0600"
  [[ "$(wc -l <"$checksum" | tr -d ' ')" == 1 ]] \
    || fail "checksum sidecar is not a strict single line"
  read -r sidecar_hash sidecar_name sidecar_extra <"$checksum"
  actual_hash="$(sha256sum "$archive")"
  actual_hash="${actual_hash%% *}"
  [[ -z "${sidecar_extra:-}" && "$sidecar_hash" == "$actual_hash" \
    && "$sidecar_name" == "$(basename -- "$archive")" \
    && "$actual_hash" =~ ^[0-9a-f]{64}$ ]] \
    || fail "checksum sidecar does not match the encrypted archive"
  cmp -s "$checksum" \
    <(printf '%s  %s\n' "$actual_hash" "$(basename -- "$archive")") \
    || fail "checksum sidecar format is not canonical"

  marker="$backup_root/state/local-last-success.env"
  [[ -f "$marker" && ! -L "$marker" \
    && "$(stat -c '%a' -- "$marker")" == 600 \
    && "$(stat -c '%u' -- "$marker")" == 0 \
    && "$(find "$backup_root/state" -mindepth 1 -maxdepth 1 -print \
      | wc -l | tr -d ' ')" == 1 ]] \
    || fail "strict local success marker is missing or unsafe"
  mapfile -t marker_lines <"$marker"
  [[ ${#marker_lines[@]} -eq 3 \
    && "${marker_lines[0]}" == SUCCESS_ARCHIVE=* \
    && "${marker_lines[1]}" == SUCCESS_COMPLETED_UTC=* \
    && "${marker_lines[2]}" == SUCCESS_SHA256=* ]] \
    || fail "strict local success marker shape is invalid"
  marker_archive="${marker_lines[0]#SUCCESS_ARCHIVE=}"
  completed_utc="${marker_lines[1]#SUCCESS_COMPLETED_UTC=}"
  marker_hash="${marker_lines[2]#SUCCESS_SHA256=}"
  [[ "$marker_archive" == "$(basename -- "$archive")" \
    && "$marker_hash" == "$actual_hash" \
    && "$completed_utc" =~ ^[0-9]{8}T[0-9]{6}Z$ ]] \
    || fail "success marker values do not match the archive"
  cmp -s "$marker" <(printf '%s\n%s\n%s\n' \
    "SUCCESS_ARCHIVE=$marker_archive" \
    "SUCCESS_COMPLETED_UTC=$completed_utc" \
    "SUCCESS_SHA256=$marker_hash") \
    || fail "success marker format is not canonical"
  normalized_completed="$(date -u -d \
    "${completed_utc:0:4}-${completed_utc:4:2}-${completed_utc:6:2} ${completed_utc:9:2}:${completed_utc:11:2}:${completed_utc:13:2} UTC" \
    +%Y%m%dT%H%M%SZ 2>/dev/null)" \
    || fail "success marker timestamp is not a real UTC time"
  [[ "$normalized_completed" == "$completed_utc" ]] \
    || fail "success marker timestamp is not canonical"

  [[ -z "$(find "$stage_root" -mindepth 1 -print -quit)" \
    && -z "$(find "$ephemeral_root" -mindepth 1 -print -quit)" \
    && -z "$(find "$backup_root/full" -maxdepth 1 -type f \
      \( -name '.*.tmp.*' -o -name '*.plaintext*' \) -print -quit)" ]] \
    || fail "plaintext, ephemeral, staging, or temporary material remained"
  [[ -z "$(docker ps -aq \
    --filter "label=com.docker.compose.project=$PRODUCTION_COMPOSE_PROJECT" \
    --filter "label=com.docker.compose.project.working_dir=$repo_root" \
    --filter 'label=com.docker.compose.service=backup-monitor')" ]] \
    || fail "backup-monitor container remained after controller exit"

  [[ -z "$(find "$verify_root" -mindepth 1 -print -quit)" \
    && "$(stat -c '%a:%u' -- "$verify_root")" == 700:0 ]] \
    || fail "fresh archive verification directory is unsafe"
  verify_result="$(BACKUP_CONFIG_FILE="$backup_config" \
    bash "$repo_root/scripts/backup/verify-archive.sh" \
      "$archive" "$age_identity" "$verify_root")" \
    || fail "real archive verifier rejected the final archive"
  [[ "$verify_result" == archive_valid=true ]] \
    || fail "real archive verifier acknowledgement is invalid"
  manifest="$verify_root/MANIFEST.txt"
  [[ -f "$manifest" && ! -L "$manifest" ]] \
    || fail "verified manifest is missing"
  grep -Fxq 'format=learncoding-backup-v1' "$manifest" \
    || fail "manifest format is invalid"
  grep -Fxq 'contains_secret_files=false' "$manifest" \
    || fail "manifest secret-file assertion is invalid"
  grep -Fxq 'contains_email_exports=false' "$manifest" \
    || fail "manifest email-export assertion is invalid"
  grep -Fxq 'app_data_included=true' "$manifest" \
    || fail "manifest did not include application data"
  grep -Eq '^database_version=postgres \(PostgreSQL\) 17([.][0-9]+)?([[:space:]].*)?$' \
    "$manifest" || fail "manifest PostgreSQL version is invalid"
  grep -Fxq "git_commit=$git_commit" "$manifest" \
    || fail "manifest Git commit does not match the real release commit"
  grep -Fxq 'migration_count=1' "$manifest" \
    || fail "manifest migration count is invalid"
  grep -Fxq 'migration_last_id=1' "$manifest" \
    || fail "manifest migration last id is invalid"
  grep -Fxq "migration_last_created_at=$migration_created_at" "$manifest" \
    || fail "manifest migration timestamp is invalid"
  grep -Fxq "migration_state_sha256=$migration_state_hash" "$manifest" \
    || fail "manifest migration state hash is invalid"
  actual_images="$test_root/manifest-images"
  grep '^image_id[.]' "$manifest" | sort >"$actual_images"
  chmod 0600 "$actual_images"
  cmp -s "$expected_images" "$actual_images" \
    || fail "manifest immutable image inventory is incomplete or changed"
  [[ "$(wc -l <"$actual_images" | tr -d ' ')" \
      == "${#REQUIRED_SERVICES[@]}" ]] \
    || fail "manifest image inventory cardinality is invalid"

  tar --extract --gzip --file "$verify_root/app-data.tar.gz" \
    --directory "$app_extract_root" --no-same-owner --no-same-permissions \
    >/dev/null 2>&1 || fail "application data extraction failed"
  [[ -f "$app_extract_root/app-data/e2e-sentinel.txt" \
    && ! -L "$app_extract_root/app-data/e2e-sentinel.txt" \
    && "$(<"$app_extract_root/app-data/e2e-sentinel.txt")" == "$app_sentinel" ]] \
    || fail "application data sentinel did not restore"

  python3 - "$verify_root/credential-probe.json" <<'PY' \
    || fail "credential probe shape is invalid"
import json
import re
import sys

with open(sys.argv[1], encoding="utf-8") as probe_file:
    value = json.load(probe_file)

if sorted(value) != ["context", "plaintextSha256", "sealed", "version"]:
    raise SystemExit(1)
if value["version"] != 1 or "plaintext" in value:
    raise SystemExit(1)
if value["context"] != {
    "credentialId": "00000000-0000-4000-8000-000000000001",
    "userId": "backup-recovery-probe",
    "provider": "nvidia_nim",
    "keyVersion": 1,
}:
    raise SystemExit(1)
sealed = value["sealed"]
if sorted(sealed) != [
    "authTag", "ciphertext", "dataIv", "keyVersion", "lastFour", "wrapIv",
    "wrappedDataKey",
]:
    raise SystemExit(1)
if sealed["keyVersion"] != 1 or not re.fullmatch(r"[A-Za-z0-9_-]{4}", sealed["lastFour"]):
    raise SystemExit(1)
for key in ["authTag", "ciphertext", "dataIv", "wrapIv", "wrappedDataKey"]:
    if not isinstance(sealed[key], str) or re.fullmatch(r"[A-Za-z0-9_-]+", sealed[key]) is None:
        raise SystemExit(1)
if re.fullmatch(r"[0-9a-f]{64}", value["plaintextSha256"]) is None:
    raise SystemExit(1)
PY

  restore_database="restore_${run_id:0:16}"
  [[ "$restore_database" =~ ^[a-z_][a-z0-9_]*$ ]] \
    || fail "restore database name is invalid"
  docker exec "$postgres_id" createdb --username=learncoding "$restore_database" \
    >/dev/null 2>&1 || fail "disposable restore database creation failed"
  docker exec -i "$postgres_id" pg_restore --username=learncoding \
    --dbname="$restore_database" --exit-on-error --no-owner --no-acl \
    <"$verify_root/database.dump" >/dev/null 2>&1 \
    || fail "real pg_restore rejected the database dump"
  restored_value="$(docker exec "$postgres_id" psql --username=learncoding \
    --dbname="$restore_database" --no-psqlrc --quiet --tuples-only --no-align \
    --set=ON_ERROR_STOP=1 \
    --command='SELECT value FROM public.backup_e2e_sentinel WHERE id = 1')" \
    || fail "restored database sentinel query failed"
  [[ "$restored_value" == "$db_sentinel" ]] \
    || fail "restored database sentinel does not match"
  original_value="$(docker exec "$postgres_id" psql --username=learncoding \
    --dbname=learncoding --no-psqlrc --quiet --tuples-only --no-align \
    --set=ON_ERROR_STOP=1 \
    --command='SELECT value FROM public.backup_e2e_sentinel WHERE id = 1')" \
    || fail "original database sentinel recheck failed"
  [[ "$original_value" == "$db_sentinel" ]] \
    || fail "original database sentinel changed"

  details="$(docker inspect --format \
    '{{.Id}}|{{.State.Running}}|{{.State.Status}}|{{.State.Health.Status}}|{{ index .Config.Labels "com.docker.compose.project" }}|{{ index .Config.Labels "com.docker.compose.project.working_dir" }}|{{ index .Config.Labels "com.docker.compose.service" }}' \
    "$postgres_id")" || fail "original PostgreSQL inspection failed"
  IFS='|' read -r full_id running status health project working_dir \
    service_label extra <<<"$details"
  [[ -z "${extra:-}" && "$full_id" == "$postgres_id" && "$running" == true \
    && "$status" == running && "$health" == healthy \
    && "$project" == "$PRODUCTION_COMPOSE_PROJECT" \
    && "$working_dir" == "$repo_root" && "$service_label" == postgres ]] \
    || fail "original PostgreSQL identity or health changed"
  mapfile -t running_services < <(docker compose --env-file "$compose_env" \
    -f "$repo_root/compose.yaml" ps --status running --services)
  [[ ${#running_services[@]} -eq 1 && "${running_services[0]}" == postgres ]] \
    || fail "post-backup running service set is not PostgreSQL-only"
  for service in "${REQUIRED_SERVICES[@]}"; do
    [[ "$service" == postgres ]] && continue
    id="$(docker compose --env-file "$compose_env" -f "$repo_root/compose.yaml" \
      ps --all --quiet --no-trunc "$service")" \
      || fail "post-backup stopped service lookup failed"
    [[ -n "$id" \
      && "$(docker inspect --format '{{.State.Status}}' "$id")" == created ]] \
      || fail "required non-PostgreSQL service did not remain created and stopped"
  done

  [[ "$(git -C "$repo_root" rev-parse --verify HEAD)" == "$git_commit" ]] \
    || fail "repository commit changed during the real backup"
  require_clean_repository "$repo_root" \
    || fail "repository or ignored generated material changed during the real backup"
  [[ -z "$(find "$repo_root" -maxdepth 1 -name "$resource_prefix*" -print -quit)" ]] \
    || fail "generated test material appeared in the repository"

  printf '%s\n' inner-backup-production-e2e-ok >"$completion_file"
  chmod 0600 "$completion_file"
}

if [[ "${BACKUP_PRODUCTION_E2E_INNER:-0}" == 1 ]]; then
  run_inner "$@"
  exit 0
fi

[[ $# -eq 0 ]] || fail "this gate accepts no developer-supplied arguments"
[[ "$(uname -s)" == Linux ]] || fail "this gate runs only on Linux"
[[ "$(id -u)" != 0 ]] || fail "host orchestrator must be non-root"
[[ "${CODESTEAD_DISPOSABLE_HOST:-}" == 1 \
  && "${GITHUB_ACTIONS:-}" == true \
  && "${RUNNER_ENVIRONMENT:-}" == github-hosted ]] \
  || fail "disposable GitHub-hosted runner acknowledgement is required"
for command_name in docker find git grep mktemp python3 realpath sha256sum stat; do
  require_command "$command_name"
done
[[ -z "${DOCKER_HOST:-}" \
  || "$DOCKER_HOST" == unix:///var/run/docker.sock ]] \
  || fail "ambient Docker host routing is forbidden"
for variable_name in DOCKER_CONTEXT DOCKER_TLS_VERIFY DOCKER_CERT_PATH \
  BUILDKIT_HOST BUILDX_BUILDER BUILDX_CONFIG; do
  [[ -z "${!variable_name:-}" ]] \
    || fail "ambient Docker or BuildKit routing is forbidden"
done
unset DOCKER_CONTEXT DOCKER_TLS_VERIFY DOCKER_CERT_PATH BUILDKIT_HOST \
  BUILDX_BUILDER BUILDX_CONFIG
export DOCKER_HOST=unix:///var/run/docker.sock
[[ -S /var/run/docker.sock ]] || fail "Docker socket is unavailable"
docker info >/dev/null 2>&1 || fail "Docker daemon is unreachable"
docker compose version >/dev/null 2>&1 || fail "Docker Compose CLI is unavailable"

script_path="$(realpath -e -- "${BASH_SOURCE[0]}")" \
  || fail "test script path is invalid"
repo_root="$(git -C "$(dirname -- "$script_path")" rev-parse --show-toplevel)" \
  || fail "repository root is unavailable"
repo_root="$(realpath -e -- "$repo_root")" || fail "repository root is invalid"
[[ "$script_path" == "$repo_root/infra/tests/backup-production-e2e.test.sh" \
  && "$(pwd -P)" == "$repo_root" ]] \
  || fail "the exact repository worktree is not the current directory"
[[ -n "${GITHUB_WORKSPACE:-}" \
  && "$(realpath -e -- "$GITHUB_WORKSPACE")" == "$repo_root" ]] \
  || fail "GitHub workspace does not match the exact repository worktree"
git -C "$repo_root" ls-files --error-unmatch \
  infra/tests/backup-production-e2e.test.sh >/dev/null 2>&1 \
  || fail "the real-tool gate is not part of the checked-out commit"
require_clean_repository "$repo_root" || fail "repository worktree is not exact and clean"
git_commit="$(git -C "$repo_root" rev-parse --verify HEAD)" \
  || fail "repository commit is unavailable"
[[ "$git_commit" =~ ^([0-9a-f]{40}|[0-9a-f]{64})$ ]] \
  || fail "repository commit is invalid"
[[ -n "${RUNNER_TEMP:-}" ]] || fail "GitHub runner temporary root is unavailable"
runner_temp="$(realpath -e -- "$RUNNER_TEMP")" \
  || fail "GitHub runner temporary root is invalid"
[[ "$runner_temp" == /* && "$runner_temp" != "$repo_root" \
  && "$runner_temp" != "$repo_root/"* && "$repo_root" != "$runner_temp/"* ]] \
  || fail "runner temporary root overlaps the repository"
assert_cleanup_rejects_docker_loss "$runner_temp"
for value in "$repo_root" "$runner_temp"; do
  single_line "$value" || fail "host path is ambiguous"
  [[ "$value" != *,* ]] || fail "host path is unsafe for Docker bind syntax"
done

run_id="$(random_hex 16)" || fail "cryptographic run identifier generation failed"
resource_prefix="codestead-bpe-$run_id"
ownership_project="$resource_prefix"
[[ "$resource_prefix" =~ ^[a-z0-9-]+$ ]] \
  || fail "resource prefix is invalid"
if [[ -n "$(docker ps -aq --filter "label=$OWNER_LABEL_KEY=$run_id")" \
  || -n "$(docker network ls -q --no-trunc \
    --filter "label=$OWNER_LABEL_KEY=$run_id")" \
  || -n "$(docker volume ls -q --filter "label=$OWNER_LABEL_KEY=$run_id")" \
  || -n "$(docker image ls -aq --filter "label=$OWNER_LABEL_KEY=$run_id")" ]]; then
  fail "a pre-existing resource carries this run's ownership label"
fi
if [[ -n "$(docker ps -aq \
    --filter "label=$OWNER_PROJECT_LABEL_KEY=$ownership_project")" \
  || -n "$(docker network ls -q --no-trunc \
    --filter "label=$OWNER_PROJECT_LABEL_KEY=$ownership_project")" \
  || -n "$(docker volume ls -q \
    --filter "label=$OWNER_PROJECT_LABEL_KEY=$ownership_project")" \
  || -n "$(docker image ls -aq \
    --filter "label=$OWNER_PROJECT_LABEL_KEY=$ownership_project")" ]]; then
  fail "a pre-existing resource carries this run's ownership project"
fi
if [[ -n "$(docker ps -aq \
    --filter "label=com.docker.compose.project=$PRODUCTION_COMPOSE_PROJECT")" \
  || -n "$(docker network ls -q --no-trunc \
    --filter "label=com.docker.compose.project=$PRODUCTION_COMPOSE_PROJECT")" \
  || -n "$(docker volume ls -q \
    --filter "label=com.docker.compose.project=$PRODUCTION_COMPOSE_PROJECT")" ]]; then
  fail "a pre-existing resource carries the production Compose project label"
fi
if docker ps -a --format '{{.Names}}' | grep -Eq "^${resource_prefix}(-|$)" \
  || docker network ls --format '{{.Name}}' | grep -Eq "^${resource_prefix}(-|$)" \
  || docker volume ls --format '{{.Name}}' | grep -Eq "^${resource_prefix}(-|$)"; then
  fail "a pre-existing resource carries this run's unique name"
fi

test_root="$(mktemp -d -- "$runner_temp/${resource_prefix}.XXXXXX")" \
  || fail "isolated test root creation failed"
trap cleanup_test EXIT INT TERM
chmod 0700 "$test_root"
toolbox_image_candidate="${resource_prefix}-toolbox:local"
if docker image inspect "$toolbox_image_candidate" >/dev/null 2>&1; then
  fail "a pre-existing image carries this run's toolbox tag"
fi
toolbox_image="$toolbox_image_candidate"
operations_tag=""
operations_digest=""
operations_image_id=""
toolbox_image_id=""
postgres_digest=""
cloudflared_digest=""
registry_id=""
registry_digest=""
registry_image_id=""
inner_complete=0
outer_docker_config="$test_root/host-docker-config"
install -d -m 0700 "$outer_docker_config" "$outer_docker_config/buildx"
export DOCKER_CONFIG="$outer_docker_config"
export BUILDX_CONFIG="$outer_docker_config/buildx"
container_ledger="$test_root/.owned-container-ids"
network_ledger="$test_root/.owned-network-ids"
volume_ledger="$test_root/.owned-volume-names"
pre_backup_container_ids="$test_root/.pre-backup-container-ids"
completion_file="$test_root/.inner-complete"
token_file="$test_root/.inner-token"
for file in "$container_ledger" "$network_ledger" "$volume_ledger" \
  "$pre_backup_container_ids" "$completion_file" "$token_file"; do
  : >"$file"
  chmod 0600 "$file"
done
inner_token="$(random_hex 32)" || fail "inner ownership token generation failed"
printf '%s\n' "$inner_token" >"$token_file"

docker build --pull=false --label "$OWNER_LABEL_KEY=$run_id" \
  --label "$OWNER_PROJECT_LABEL_KEY=$ownership_project" \
  --tag "$toolbox_image" --file "$repo_root/infra/tests/backup-toolbox.Dockerfile" \
  "$repo_root" >/dev/null \
  || fail "disposable backup toolbox build failed"
toolbox_image_id="$(docker image inspect --format '{{.Id}}' "$toolbox_image")" \
  || fail "toolbox image inspection failed"
[[ "$toolbox_image_id" =~ ^sha256:[0-9a-f]{64}$ \
  && "$(docker image inspect --format \
    "{{ index .Config.Labels \"$OWNER_LABEL_KEY\" }}" "$toolbox_image")" == "$run_id" \
  && "$(docker image inspect --format \
    "{{ index .Config.Labels \"$OWNER_PROJECT_LABEL_KEY\" }}" \
    "$toolbox_image")" == "$ownership_project" ]] \
  || fail "toolbox image ownership is invalid"

docker pull postgres:17-bookworm >/dev/null \
  || fail "PostgreSQL 17 image pull failed"
docker pull cloudflare/cloudflared:latest >/dev/null \
  || fail "cloudflared image pull failed"
docker pull registry:2 >/dev/null || fail "loopback registry image pull failed"
postgres_digest="$(image_repo_digest postgres:17-bookworm postgres)" \
  || fail "PostgreSQL immutable RepoDigest is unavailable"
cloudflared_digest="$(image_repo_digest \
  cloudflare/cloudflared:latest cloudflare/cloudflared)" \
  || fail "cloudflared immutable RepoDigest is unavailable"
registry_digest="$(image_repo_digest registry:2 registry)" \
  || fail "loopback registry immutable RepoDigest is unavailable"
registry_image_id="$(docker image inspect --format '{{.Id}}' "$registry_digest")" \
  || fail "loopback registry immutable image ID is unavailable"
[[ "$registry_digest" =~ ^registry@sha256:[0-9a-f]{64}$ \
  && "$registry_image_id" =~ ^sha256:[0-9a-f]{64}$ ]] \
  || fail "loopback registry immutable image identity is invalid"

registry_id="$(docker run --detach --name "$resource_prefix-registry" \
  --label "$OWNER_LABEL_KEY=$run_id" \
  --label "$OWNER_PROJECT_LABEL_KEY=$ownership_project" \
  --publish 127.0.0.1::5000 --read-only --cap-drop ALL \
  --security-opt no-new-privileges --pids-limit 128 --memory 256m \
  --tmpfs /tmp:rw,noexec,nosuid,nodev,size=16m \
  --tmpfs /var/lib/registry:rw,noexec,nosuid,nodev,size=1g \
  "$registry_digest")" || fail "loopback registry did not start"
[[ "$registry_id" =~ ^[0-9a-f]{64}$ ]] \
  || fail "loopback registry identity is invalid"
registry_details="$(docker inspect --format \
  '{{.Id}}|{{.Config.Image}}|{{.Image}}|{{.Name}}' "$registry_id")" \
  || fail "loopback registry inspection failed"
IFS='|' read -r full_id configured_image runtime_image registry_name extra \
  <<<"$registry_details"
[[ -z "${extra:-}" && "$full_id" == "$registry_id" \
  && "$configured_image" == "$registry_digest" \
  && "$runtime_image" == "$registry_image_id" \
  && "$registry_name" == "/$resource_prefix-registry" \
  && "$(docker_label_value "$registry_id" "$OWNER_LABEL_KEY")" == "$run_id" \
  && "$(docker_label_value "$registry_id" "$OWNER_PROJECT_LABEL_KEY")" \
    == "$ownership_project" ]] \
  || fail "loopback registry ownership is invalid"
printf '%s\n' "$registry_id" >>"$container_ledger"
registry_binding="$(docker port "$registry_id" 5000/tcp)" \
  || fail "loopback registry binding is unavailable"
[[ "$registry_binding" =~ ^127[.]0[.]0[.]1:([1-9][0-9]{0,4})$ ]] \
  || fail "registry is not bound exclusively to loopback"
registry_port="${BASH_REMATCH[1]}"
((registry_port <= 65535)) || fail "loopback registry port is invalid"
registry_endpoint="127.0.0.1:$registry_port"
registry_ready=0
for _ in {1..30}; do
  if python3 - "$registry_endpoint" >/dev/null 2>&1 <<'PY'
import sys
import urllib.request

with urllib.request.urlopen(f"http://{sys.argv[1]}/v2/", timeout=1) as response:
    if response.status != 200:
        raise SystemExit(1)
PY
  then
    registry_ready=1
    break
  fi
  sleep 1
done
((registry_ready == 1)) || fail "loopback registry did not become ready"

operations_repository="$registry_endpoint/$resource_prefix/operations"
operations_tag_candidate="$operations_repository:$run_id"
if docker image inspect "$operations_tag_candidate" >/dev/null 2>&1; then
  fail "a pre-existing image carries this run's operations tag"
fi
operations_tag="$operations_tag_candidate"
docker build --pull=false --target operations \
  --label "$OWNER_LABEL_KEY=$run_id" \
  --label "$OWNER_PROJECT_LABEL_KEY=$ownership_project" \
  --tag "$operations_tag" "$repo_root" >/dev/null \
  || fail "real operations target build failed"
docker push "$operations_tag" >/dev/null \
  || fail "operations image loopback publication failed"
operations_digest="$(image_repo_digest "$operations_tag" "$operations_repository")" \
  || fail "operations image immutable local RepoDigest is unavailable"
operations_image_id="$(docker image inspect --format '{{.Id}}' "$operations_digest")" \
  || fail "operations digest inspection failed"
[[ "$operations_image_id" =~ ^sha256:[0-9a-f]{64}$ \
  && "$(docker image inspect --format \
    "{{ index .Config.Labels \"$OWNER_LABEL_KEY\" }}" "$operations_digest")" == "$run_id" \
  && "$(docker image inspect --format \
    "{{ index .Config.Labels \"$OWNER_PROJECT_LABEL_KEY\" }}" \
    "$operations_digest")" == "$ownership_project" ]] \
  || fail "operations image ownership is invalid"

docker run --rm --name "$resource_prefix-toolbox" \
  --hostname "$resource_prefix-toolbox" \
  --label "$OWNER_LABEL_KEY=$run_id" \
  --label "$OWNER_PROJECT_LABEL_KEY=$ownership_project" \
  --network none --read-only --cap-drop ALL \
  --security-opt no-new-privileges --pids-limit 512 --memory 1g --cpus 2 \
  --tmpfs /tmp:rw,noexec,nosuid,nodev,size=256m \
  --mount type=bind,src=/var/run/docker.sock,dst=/var/run/docker.sock \
  --mount "type=bind,src=$repo_root,dst=$repo_root,readonly" \
  --mount "type=bind,src=$test_root,dst=$test_root" \
  --env BACKUP_PRODUCTION_E2E_INNER=1 \
  --env CODESTEAD_DISPOSABLE_HOST=1 --env GITHUB_ACTIONS=true \
  --env RUNNER_ENVIRONMENT=github-hosted \
  --env "BACKUP_E2E_ROOT=$test_root" \
  --env "BACKUP_E2E_REPO_ROOT=$repo_root" \
  --env "BACKUP_E2E_RUN_ID=$run_id" \
  --env "BACKUP_E2E_RESOURCE_PREFIX=$resource_prefix" \
  --env "BACKUP_E2E_OWNERSHIP_PROJECT=$ownership_project" \
  --env "BACKUP_E2E_OPERATIONS_DIGEST=$operations_digest" \
  --env "BACKUP_E2E_POSTGRES_DIGEST=$postgres_digest" \
  --env "BACKUP_E2E_CLOUDFLARED_DIGEST=$cloudflared_digest" \
  --env "BACKUP_E2E_CONTAINER_LEDGER=$container_ledger" \
  --env "BACKUP_E2E_NETWORK_LEDGER=$network_ledger" \
  --env "BACKUP_E2E_VOLUME_LEDGER=$volume_ledger" \
  --env "BACKUP_E2E_PRE_BACKUP_CONTAINER_IDS=$pre_backup_container_ids" \
  --env "BACKUP_E2E_COMPLETION_FILE=$completion_file" \
  --env "BACKUP_E2E_TOKEN_FILE=$token_file" \
  --env "BACKUP_E2E_INNER_TOKEN=$inner_token" \
  --entrypoint /bin/bash "$toolbox_image" \
  "$repo_root/infra/tests/backup-production-e2e.test.sh" --inside-toolbox \
  || fail "isolated real-tool backup run failed"

[[ -f "$completion_file" && ! -L "$completion_file" \
  && "$(stat -c '%a' -- "$completion_file")" == 600 \
  && "$(<"$completion_file")" == inner-backup-production-e2e-ok ]] \
  || fail "inner real-tool completion proof is invalid"
inner_complete=1
