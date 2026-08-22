#!/usr/bin/env bash
# Uruchamia TYLKO faze BEFORE regresji finansowej przeciw dzialajacemu monize.
# Tryb URL (README: "Manual / URL mode") -- harness nie startuje zadnych
# kontenerow, tylko loguje sie przez przegladarke i czyta wartosci.
#
# Wynik: artifacts/before.json  (git-ignorowany; zawiera realne kwoty).
set -euo pipefail
cd "$(dirname "$0")"

if [[ ! -f regression.env ]]; then
  echo "Brak regression.env -- wypelnij go najpierw." >&2
  exit 1
fi

# Bezpieczny parser KEY=VALUE. NIE uzywamy `source`, bo bash interpretowalby
# backslashe i znaki specjalne w hasle (np. '\' albo '$'). `read -r` zachowuje
# wartosc doslownie -- tak samo jak parser harnessu (scripts/lib/env.mjs).
while IFS= read -r line || [[ -n "$line" ]]; do
  line="${line%$'\r'}"                              # utnij ewentualny CR (CRLF)
  line="${line#"${line%%[![:space:]]*}"}"           # ltrim
  [[ -z "$line" || "$line" == \#* ]] && continue    # pomin puste i komentarze
  [[ "$line" != *"="* ]] && continue
  key="${line%%=*}"
  val="${line#*=}"
  key="${key//[[:space:]]/}"                         # klucz bez bialych znakow
  val="${val#"${val%%[![:space:]]*}"}"              # ltrim wartosci
  val="${val%"${val##*[![:space:]]}"}"              # rtrim wartosci
  if [[ ( "$val" == \"*\" && ${#val} -ge 2 ) || ( "$val" == \'*\' && ${#val} -ge 2 ) ]]; then
    val="${val:1:${#val}-2}"                         # zdejmij otaczajace cudzyslowy
  fi
  export "$key=$val"
done < regression.env

: "${MONIZE_BEFORE_URL:?ustaw MONIZE_BEFORE_URL w regression.env}"
if [[ -z "${MONIZE_USER_EMAIL:-}" || -z "${MONIZE_USER_PASSWORD:-}" ]]; then
  echo "Uzupelnij MONIZE_USER_EMAIL i MONIZE_USER_PASSWORD w regression.env." >&2
  exit 1
fi

export BASE_URL="$MONIZE_BEFORE_URL"
export REGRESSION_PHASE=before

echo "[before] BASE_URL=$BASE_URL  user=$MONIZE_USER_EMAIL"
echo "[before] uruchamiam capture (read-only)..."
npx playwright test capture

echo
echo "[before] Gotowe. Artefakt:"
ls -l artifacts/before.json 2>/dev/null || echo "  (brak before.json -- sprawdz log wyzej)"
