#!/usr/bin/env bash
# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0

set -u
set -o pipefail

die() {
  printf 'nemoclaw-ssh-proxy: %s\n' "$*" >&2
  exit 1
}

is_port() {
  local value="${1:-}"
  [[ "$value" =~ ^[0-9]+$ ]] && ((10#$value >= 1 && 10#$value <= 65535))
}

select_proxy_url() {
  if [ -n "${HTTPS_PROXY:-}" ]; then
    proxy_env_name="HTTPS_PROXY"
    proxy_url="$HTTPS_PROXY"
    return 0
  fi
  if [ -n "${HTTP_PROXY:-}" ]; then
    proxy_env_name="HTTP_PROXY"
    proxy_url="$HTTP_PROXY"
    return 0
  fi
  if [ -n "${ALL_PROXY:-}" ]; then
    proxy_env_name="ALL_PROXY"
    proxy_url="$ALL_PROXY"
    return 0
  fi

  die "No proxy configured; set HTTPS_PROXY, HTTP_PROXY, or ALL_PROXY to an http:// proxy URL."
}

parse_proxy_url() {
  local rest authority

  case "$proxy_url" in
    http://*) ;;
    *) die "Proxy URL in ${proxy_env_name} must use http://; only http:// proxy URLs are supported." ;;
  esac

  rest="${proxy_url#http://}"
  authority="${rest%%/*}"
  authority="${authority%%\?*}"
  authority="${authority%%#*}"
  [ -n "$authority" ] || die "Proxy URL in ${proxy_env_name} is missing a host."

  proxy_auth=""
  if [[ "$authority" == *@* ]]; then
    proxy_auth="${authority%@*}"
    authority="${authority##*@}"
    [ -n "$proxy_auth" ] || die "Proxy URL in ${proxy_env_name} has empty credentials."
  fi

  case "$authority" in
    \[*\]*) die "IPv6 proxy addresses are not supported by this helper; use an IPv4 address or DNS name." ;;
  esac

  if [[ "$authority" == *:* ]]; then
    proxy_host="${authority%%:*}"
    proxy_port="${authority##*:}"
  else
    proxy_host="$authority"
    proxy_port="80"
  fi

  [ -n "$proxy_host" ] || die "Proxy URL in ${proxy_env_name} is missing a host."
  [[ "$proxy_host" != *[:/@]* ]] || die "Proxy URL in ${proxy_env_name} has an invalid host."
  [[ "$proxy_host" != *$'\r'* && "$proxy_host" != *$'\n'* ]] \
    || die "Proxy URL in ${proxy_env_name} has an invalid host."
  [[ "$proxy_host" != *[[:space:]]* ]] || die "Proxy URL in ${proxy_env_name} has an invalid host."
  is_port "$proxy_port" || die "Proxy URL in ${proxy_env_name} has an invalid port."
}

validate_target() {
  [ -n "$target_host" ] || die "Missing target host argument."
  [[ "$target_host" != *$'\r'* && "$target_host" != *$'\n'* ]] \
    || die "Target host contains invalid characters."
  [[ "$target_host" != *[[:space:]]* ]] || die "Target host contains invalid whitespace."
  is_port "$target_port" || die "Invalid target port argument."
}

connect_to_proxy() {
  if ! { exec 3<>"/dev/tcp/${proxy_host}/${proxy_port}"; } 2>/dev/null; then
    die "Failed to connect to HTTP proxy ${proxy_host}:${proxy_port}."
  fi
}

send_connect_request() {
  local proxy_auth_header=""

  if [ -n "$proxy_auth" ]; then
    proxy_auth_header="$(printf '%s' "$proxy_auth" | base64 | tr -d '\n')" \
      || die "Failed to create Proxy-Authorization header."
  fi

  {
    printf 'CONNECT %s:%s HTTP/1.1\r\n' "$target_host" "$target_port"
    printf 'Host: %s:%s\r\n' "$target_host" "$target_port"
    printf 'Proxy-Connection: Keep-Alive\r\n'
    if [ -n "$proxy_auth_header" ]; then
      printf 'Proxy-Authorization: Basic %s\r\n' "$proxy_auth_header"
    fi
    printf '\r\n'
  } >&3 || die "Failed to write CONNECT request to HTTP proxy."
}

read_connect_response() {
  local status_line status_code header_line

  if ! IFS= read -r -u 3 status_line; then
    die "HTTP proxy closed the connection before sending a CONNECT response."
  fi
  status_line="${status_line%$'\r'}"

  status_code=""
  if [[ "$status_line" =~ ^HTTP/[0-9.]+[[:space:]]+([0-9]{3})([[:space:]]|$) ]]; then
    status_code="${BASH_REMATCH[1]}"
  fi

  if [ "$status_code" != "200" ]; then
    [ -n "$status_code" ] || status_code="invalid response"
    die "HTTP proxy CONNECT failed: expected HTTP 200, got ${status_code}."
  fi

  while IFS= read -r -u 3 header_line; do
    header_line="${header_line%$'\r'}"
    [ -z "$header_line" ] && return 0
  done

  die "HTTP proxy closed the connection while sending CONNECT headers."
}

forward_tunnel() {
  local stdin_pid status

  cat >&3 &
  stdin_pid="$!"

  status=0
  cat <&3 || status="$?"

  kill "$stdin_pid" 2>/dev/null || true
  wait "$stdin_pid" 2>/dev/null || true
  return "$status"
}

if [ "$#" -ne 2 ]; then
  die "Usage: nemoclaw-ssh-proxy <host> <port>."
fi

target_host="$1"
target_port="$2"
proxy_env_name=""
proxy_url=""
proxy_host=""
proxy_port=""
proxy_auth=""

validate_target
select_proxy_url
parse_proxy_url
connect_to_proxy
send_connect_request
read_connect_response
forward_tunnel
