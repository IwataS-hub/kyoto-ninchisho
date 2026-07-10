"""
厚労省「医療情報ネット」全国版CSV（病院/診療所 × 施設票/診療科・時間票の4ファイル）から
認知症対応医療機関を抽出し、clinics.geojson を生成する。

【抽出スコープ（--scope オプション）】
- --scope city（デフォルト）: 京都市内の施設のみ抽出する（議事録2026-06-20の方針）。
  「住所が『京都府京都市』で始まる」または「市区町村コードが京都市（26100番台 =
  261xx: 26100 京都市 / 26101〜26111 各区）」のいずれかに該当する施設。
  認知症疾患医療センター(kyoto_dementia_centers.csv)も京都市内のもののみ統合する。
- --scope pref: 従来どおり京都府全域（都道府県コード26）。

【データソースに関する制約・判断根拠】
- 4ファイルのいずれにも電話番号(TEL)の列が存在しない。
  → properties.tel には代わりに「案内用ホームページアドレス」列の値を入れる（ユーザー確認済み）。
- 都道府県を表す列はテキストの「都道府県」ではなく数値の「都道府県コード」のみ。
  → 京都府コード "26" で絞り込む（ユーザー確認済み）。
- 「対応可能な疾患」を表す専用列は存在しない。診療科目名（自由記述）に
  "もの忘れ外来" "認知症外来" 等の値が実在することを事前調査で確認したため、
  診療科目名の文字列マッチで判定する（ユーザー確認済み）。
- 施設票(facility_info系)には在宅医療・往診・訪問診療に関する専用列が無い
  （列一覧を確認済み）。zaitaku 判定は診療科目名のマッチのみで行う。
- 認知症サポート医(supportdoc)はこのデータセットに登録情報が一切無いため、
  常に false とする。別途、都道府県等が公開するサポート医名簿との突き合わせが必要。

【抽出範囲を「関連診療科まで」広げた経緯】
診療科目名に「認知症」「もの忘れ」「物忘れ」を厳密に含む施設のみで絞り込むと、
京都府では 0 件だった（全国的にもこの自由記述で明記している施設は極めて少ない）。
施設名（正式名称・略称）まで含めても京都府で 2 件のみとなり、アプリの母集団として
不十分と判断（ユーザー確認済み）。そのため、認知症診療と関連が深い診療科
（精神科・神経内科・脳神経内科・老年科）まで抽出対象を広げている。
ただし shindan / monowasure の bool フラグは「精神科」等の広い科だけでは
true にせず、診療科目名または施設名に「認知症」「もの忘れ」「物忘れ」を
明記している場合のみ true とする（広い科だけの施設は実態不明のため4フラグとも false）。

【properties.level（認知症対応の確からしさ）】
- "専門": 診療科目名または施設名（正式名称・略称）に「認知症」「もの忘れ」「物忘れ」を
  明記している施設（厳密一致）。
- "関連": 上記に該当しないが、精神科・神経内科・脳神経内科・老年科など
  認知症診療と関連が深い診療科で拾った施設（広い条件のみで一致）。

【京都府認知症疾患医療センター(kyoto_dementia_centers.csv)の統合】
医療情報ネット由来の193件に、京都府が指定する認知症疾患医療センター9件を統合する。
名寄せは「全角/半角スペースの除去」＋「法人格・所属法人名（医療法人◯◯会、
一般財団法人◯◯協会等）の除去」で表記ゆれを吸収して比較する（normalize_name）。
一致した場合はセンター側の情報（name/area/address/tel/lat/lon/4フラグ/source）で
既存レコードを上書きし level="専門" にする。一致しない場合は新規レコードとして追加し、
source列に "京都府認知症疾患医療センター" を設定する。
医療情報ネット由来のレコードには area="" 、source="医療情報ネット" を既定値として補う。
"""

import argparse
import csv
import json
import re
import sys
import time
import urllib.parse
import urllib.request
from pathlib import Path

BASE_DIR = Path(__file__).resolve().parent

HOSPITAL_FACILITY_CSV = BASE_DIR / "01-1_hospital_facility_info_20251201.csv"
HOSPITAL_HOURS_CSV = BASE_DIR / "01-2_hospital_speciality_hours_20251201.csv"
CLINIC_FACILITY_CSV = BASE_DIR / "02-1_clinic_facility_info_20251201.csv"
CLINIC_HOURS_CSV = BASE_DIR / "02-2_clinic_speciality_hours_20251201.csv"
DEMENTIA_CENTERS_CSV = BASE_DIR / "kyoto_dementia_centers.csv"
MONOWASURE_HOSPITALS_CSV = BASE_DIR / "kyoto_city_monowasure.csv"
OUTPUT_GEOJSON = BASE_DIR / "clinics.geojson"
INDEX_HTML = BASE_DIR / "index.html"

# index.html 内のキャッシュバスター定義（const DATA_VERSION = "YYYYMMDD";）を
# 特定するためのパターン。この形からずれた場合は自動書き換えを行わない。
DATA_VERSION_RE = re.compile(r'(const DATA_VERSION = ")(\d{8})(";)')

KYOTO_PREF_CODE = "26"  # JIS X 0401 都道府県コード: 26 = 京都府
# 京都市の全国地方公共団体コードは 26100（市）と 26101〜26111（行政区）。
# ただし医療情報ネットCSVの「市区町村コード」列は都道府県部を除いた3桁
# （例: 上京区=102、福知山市=201）で収録されているため、
# 「都道府県コード26 かつ 市区町村コードが1xx」も京都市と判定する。
KYOTO_CITY_CODE_PREFIX = "261"
KYOTO_CITY_ADDR_PREFIX = "京都府京都市"

# 診療科目名 or 施設名にこれらの文字列を含む施設を「専門」(level=専門)とみなす（厳密一致）
STRICT_KEYWORDS = ("認知症", "もの忘れ", "物忘れ")
# 上記に該当しない施設のうち、これらの診療科目名を持つ施設を「関連」(level=関連)として追加で抽出
RELATED_DEPT_KEYWORDS = ("精神科", "神経内科", "脳神経内科", "老年")
# shindan（鑑別診断）: 明示的に「認知症」を診療科目名 or 施設名に含むもの
SHINDAN_KEYWORDS = ("認知症",)
# monowasure（もの忘れ外来）: もの忘れ系の表記、および「認知症外来」も含める（ユーザー指定）
MONOWASURE_KEYWORDS = ("もの忘れ", "物忘れ", "認知症外来")
# zaitaku（訪問診療・在宅）: 診療科目名のみで判定（施設票に該当列が無いため）
ZAITAKU_KEYWORDS = ("在宅", "訪問")

GSI_GEOCODE_URL = "https://msearch.gsi.go.jp/address-search/AddressSearch?q="
GEOCODE_SLEEP_SEC = 0.3

# 京都府の緯度経度の妥当範囲（この範囲外、または0付近・変換不可な値は無効座標として再ジオコーディングする）
KYOTO_LAT_RANGE = (34.0, 36.0)
KYOTO_LON_RANGE = (135.0, 136.0)
NEAR_ZERO_THRESHOLD = 0.01

# 名寄せ時に除去する法人格・所属法人の接頭辞（長い表記から先に除去する）
LEGAL_ENTITY_PREFIXES = (
    "独立行政法人", "一般財団法人", "公益財団法人", "一般社団法人", "公益社団法人",
    "特定医療法人", "社会医療法人", "医療法人財団", "医療法人社団",
    "社会福祉法人", "学校法人", "特定非営利活動法人", "NPO法人", "医療法人",
)


def is_kyoto_city(address, city_code):
    """住所または市区町村コードから京都市内の施設かどうかを判定する。

    住所が「京都府京都市」で始まる、または市区町村コードが京都市
    （26100番台）のいずれかで京都市内とみなす。コード列は5桁（261xx）と
    3桁（都道府県部を除いた 1xx。都道府県コード26で絞り込み済みの文脈で使う）
    の両方の形式に対応する。
    """
    if address.strip().startswith(KYOTO_CITY_ADDR_PREFIX):
        return True
    code = city_code.strip()
    if code.startswith(KYOTO_CITY_CODE_PREFIX):
        return True
    return len(code) == 3 and code.startswith("1")


def load_kyoto_facilities(path, scope):
    """施設票(facility_info系)を読み込み、スコープ内の施設だけを dict で返す。

    scope="pref": 京都府全域（都道府県コード==26）
    scope="city": 上記のうち京都市内（is_kyoto_city 判定）のみ
    """
    facilities = {}
    with path.open(encoding="utf-8-sig", newline="") as fh:
        reader = csv.reader(fh)
        header = next(reader)
        idx_id = header.index("ID")
        idx_name = header.index("正式名称")
        idx_abbr = header.index("略称")
        idx_pref = header.index("都道府県コード")
        idx_city = header.index("市区町村コード")
        idx_address = header.index("所在地")
        idx_lat = header.index("所在地座標（緯度）")
        idx_lon = header.index("所在地座標（経度）")
        idx_url = header.index("案内用ホームページアドレス")

        for row in reader:
            if row[idx_pref] != KYOTO_PREF_CODE:
                continue
            if scope == "city" and not is_kyoto_city(row[idx_address], row[idx_city]):
                continue
            facility_id = row[idx_id]
            facilities[facility_id] = {
                "name": row[idx_name],
                "abbr": row[idx_abbr],
                "address": row[idx_address],
                "lat": row[idx_lat].strip(),
                "lon": row[idx_lon].strip(),
                "url": row[idx_url].strip(),
            }
    return facilities


def load_dept_names(path, target_ids):
    """診療科・診療時間票を読み込み、target_ids に含まれる施設IDの診療科目名を集める。"""
    dept_names = {}
    with path.open(encoding="utf-8-sig", newline="") as fh:
        reader = csv.reader(fh)
        header = next(reader)
        idx_id = header.index("ID")
        idx_dept = header.index("診療科目名")

        for row in reader:
            facility_id = row[idx_id]
            if facility_id not in target_ids:
                continue
            dept_names.setdefault(facility_id, set()).add(row[idx_dept])
    return dept_names


def matches_any(texts, keywords):
    return any(kw in text for text in texts for kw in keywords)


def is_valid_kyoto_coords(lat, lon):
    """lat/lonが京都府内として妥当な数値かどうかを判定する。

    float変換できない、0付近、または京都府の妥当範囲（緯度34-36, 経度135-136）から
    大きく外れる場合は無効（再ジオコーディングが必要）とみなす。
    """
    try:
        lat_f = float(lat)
        lon_f = float(lon)
    except (TypeError, ValueError):
        return False
    if abs(lat_f) < NEAR_ZERO_THRESHOLD and abs(lon_f) < NEAR_ZERO_THRESHOLD:
        return False
    if not (KYOTO_LAT_RANGE[0] <= lat_f <= KYOTO_LAT_RANGE[1]):
        return False
    if not (KYOTO_LON_RANGE[0] <= lon_f <= KYOTO_LON_RANGE[1]):
        return False
    return True


def _request_gsi_all(query):
    """国土地理院ジオコーディングAPIに1回問い合わせ、候補リスト全体を返す。失敗時は空リスト。"""
    url = GSI_GEOCODE_URL + urllib.parse.quote(query)
    try:
        with urllib.request.urlopen(url, timeout=10) as resp:
            data = json.loads(resp.read().decode("utf-8"))
        if isinstance(data, list):
            return data
    except Exception as exc:
        print(f"  [WARN] ジオコーディング失敗: {query!r} ({exc})", file=sys.stderr)
    return []


def _request_gsi(address):
    """国土地理院ジオコーディングAPIに1回問い合わせる。失敗時はNone。"""
    data = _request_gsi_all(address)
    if data:
        return data[0]["geometry"]["coordinates"]  # [lon, lat]
    return None


def geocode_gsi(address):
    """国土地理院ジオコーディングAPIで住所→[lon, lat]を取得。失敗時はNone。

    京都市内の住所では区名の直後に「四条通高倉西」のような通り名（俗称の
    ストリート方式表記）が前置されることがあり、そのままではGSIの検索が
    空振りすることがある。その場合は区/市の直後から1文字ずつ削って再試行し、
    京都府内として妥当な座標が得られた時点で採用する。
    """
    coords = _request_gsi(address)
    if coords is not None:
        return coords

    boundary = max(address.rfind("区"), address.rfind("市"))
    if boundary == -1:
        return None
    prefix = address[: boundary + 1]
    rest = address[boundary + 1:]
    for trim in range(1, min(15, len(rest))):
        time.sleep(GEOCODE_SLEEP_SEC)
        coords = _request_gsi(prefix + rest[trim:])
        if coords is not None and is_valid_kyoto_coords(coords[1], coords[0]):
            print(f"  [INFO] 通り名を除去して再ジオコーディング成功: {address!r}", file=sys.stderr)
            return coords
    return None


def build_dementia_features(facilities, dept_names):
    """施設票×診療科目名を施設IDで結合し、認知症対応施設だけ抽出してフラグ・levelを付与する。"""
    records = []
    for facility_id, info in facilities.items():
        depts = dept_names.get(facility_id, set())
        # 診療科目名 + 施設名（正式名称・略称）の両方を判定対象にする
        texts = set(depts)
        texts.add(info["name"])
        texts.add(info["abbr"])

        is_strict = matches_any(texts, STRICT_KEYWORDS)
        is_related = matches_any(depts, RELATED_DEPT_KEYWORDS)
        if not (is_strict or is_related):
            continue

        records.append({
            "id": facility_id,
            "name": info["name"],
            "address": info["address"],
            "tel": info["url"],  # 電話番号列が無いためホームページURLで代用（ユーザー確認済み）
            "lat": info["lat"],
            "lon": info["lon"],
            "level": "専門" if is_strict else "関連",
            "shindan": matches_any(texts, SHINDAN_KEYWORDS),
            "monowasure": matches_any(texts, MONOWASURE_KEYWORDS),
            "zaitaku": matches_any(depts, ZAITAKU_KEYWORDS),
            "supportdoc": False,  # このデータセットには認知症サポート医の登録情報が無い
        })
    return records


def normalize_name(name):
    """全角/半角スペースと法人格・所属法人名の表記ゆれを除去して名寄せ用の文字列を作る。"""
    normalized = name.replace("　", "").replace(" ", "").strip()
    for prefix in LEGAL_ENTITY_PREFIXES:
        normalized = normalized.replace(prefix, "")
    return normalized


def core_name(name):
    """スペース区切りの末尾要素（=法人名を除いた施設名部分）を正規化して返す。

    医療情報ネット・あんしんナビとも「法人格＋法人名＋スペース＋施設名」の表記が
    多い一方、片側だけ法人名を含まないケースがある（例: 医療情報ネット「室町病院」
    vs あんしんナビ「医療法人幸生会 室町病院」）。その名寄せ用の第2キーとして、
    スペース区切りの最後の要素を normalize_name して使う。
    完全一致でのみ比較する（後方一致だと「武田病院」が「京都武田病院」に
    誤マッチするため使わない）。「北山病院」と「第二北山病院」は末尾要素が
    異なる文字列になるので誤一致しない。スペースが無い名前では normalize_name と
    同じ結果になる。
    """
    parts = re.split(r"[\s　]+", name.strip())
    return normalize_name(parts[-1])


def load_dementia_centers(path, scope):
    """京都府認知症疾患医療センターCSVを読み込み、bool変換済みのレコード一覧を返す。

    scope="city" の場合は京都市内のセンター（住所判定）のみに絞り込む。
    センターCSVには市区町村コード列が無いため、住所の前方一致のみで判定する。
    """
    centers = []
    with path.open(encoding="utf-8-sig", newline="") as fh:
        reader = csv.DictReader(fh)
        for row in reader:
            if scope == "city" and not is_kyoto_city(row["address"], ""):
                continue
            centers.append({
                "name": row["name"].strip(),
                "area": row["area"].strip(),
                "address": row["address"].strip(),
                "tel": row["tel"].strip(),
                "lat": row["lat"].strip(),
                "lon": row["lon"].strip(),
                "level": row["level"].strip(),
                "shindan": row["shindan"].strip().lower() == "true",
                "monowasure": row["monowasure"].strip().lower() == "true",
                "zaitaku": row["zaitaku"].strip().lower() == "true",
                "supportdoc": row["supportdoc"].strip().lower() == "true",
                "source": row["source"].strip(),
            })
    return centers


def merge_dementia_centers(records, centers):
    """名寄せして既存レコードをセンター情報で上書き、一致しないものは新規追加する。"""
    for rec in records:
        rec.setdefault("area", "")
        rec.setdefault("source", "医療情報ネット")

    name_index = {normalize_name(rec["name"]): rec for rec in records}

    matched_count = 0
    added_count = 0
    for center in centers:
        key = normalize_name(center["name"])
        target = name_index.get(key)
        if target is not None:
            target.update({
                "name": center["name"],
                "area": center["area"],
                "address": center["address"],
                "tel": center["tel"],
                "lat": center["lat"],
                "lon": center["lon"],
                "level": "専門",
                "shindan": center["shindan"],
                "monowasure": center["monowasure"],
                "zaitaku": center["zaitaku"],
                "supportdoc": center["supportdoc"],
                "source": center["source"],
            })
            matched_count += 1
        else:
            new_rec = dict(center)
            new_rec["id"] = None
            records.append(new_rec)
            name_index[key] = new_rec
            added_count += 1
    return matched_count, added_count


def load_monowasure_hospitals(path):
    """きょうと認知症あんしんナビ「もの忘れ外来一覧」CSV（京都市内の病院）を読み込む。"""
    hospitals = []
    with path.open(encoding="utf-8-sig", newline="") as fh:
        reader = csv.DictReader(fh)
        for row in reader:
            hospitals.append({
                "name": row["name"].strip(),
                "ward": row["ward"].strip(),   # 例: "京都市北区"
                "tel": row["tel"].strip(),
                "source": row["source"].strip(),
            })
    return hospitals


# 法人名の末尾によく現れる語。suffix一致名寄せ（第3パス）で、除去される接頭辞が
# 「法人名らしい」ことの確認に使う（例:「愛智会」「地域医療機能推進機構」）。
CORPORATE_SUFFIXES = ("会", "法人", "機構", "協会", "財団", "社団", "組合")

# 施設名POIジオコーディングの採用条件: 区の代表点からこの距離以内であること。
# 同名施設の誤マッチ（例: 長崎県の島原病院）を弾きつつ、南北に長い左京区・右京区の
# 市街地部の施設は拾える距離として設定。
POI_MATCH_MAX_KM = 15.0


def haversine_km(lat1, lon1, lat2, lon2):
    """2点間の大円距離(km)。"""
    from math import atan2, cos, radians, sin, sqrt
    r = 6371.0
    dlat = radians(lat2 - lat1)
    dlon = radians(lon2 - lon1)
    a = sin(dlat / 2) ** 2 + cos(radians(lat1)) * cos(radians(lat2)) * sin(dlon / 2) ** 2
    return r * 2 * atan2(sqrt(a), sqrt(1 - a))


def geocode_poi(simple_name, ward, ward_coords_cache):
    """国土地理院APIで施設名POIを検索し、[lon, lat] を返す。特定できなければ None。

    AddressSearch は住所だけでなく主要施設名のPOIも収載しているが、
    「区名＋施設名」で問い合わせると住所前方一致（区の代表点）が最上位に来て
    しまい、区役所付近の不正確な座標を拾ってしまう。そのため:
    1) 施設名単独で問い合わせ、title に施設名を含む候補だけを採用する
       （住所の部分一致候補は title が「京都府京都市北区」等になるため除外される）
    2) 同名・類似名POIの誤マッチを防ぐため、区の代表点から POI_MATCH_MAX_KM
       以内であることを必須にする（府内妥当範囲チェックだけでは大阪等の
       同名施設を弾けない）
    確実に特定できない場合は None を返し、呼び出し側で「未特定」として扱う
    （区代表点などの不正確な座標で登録するより、追加しない方が安全のため）。
    """
    if ward not in ward_coords_cache:
        time.sleep(GEOCODE_SLEEP_SEC)
        ward_coords_cache[ward] = _request_gsi(ward)  # [lon, lat] or None
    ward_coords = ward_coords_cache[ward]
    if ward_coords is None:
        return None

    time.sleep(GEOCODE_SLEEP_SEC)
    for cand in _request_gsi_all(simple_name):
        title = (cand.get("properties") or {}).get("title") or ""
        if simple_name not in title:
            continue
        coords = cand["geometry"]["coordinates"]  # [lon, lat]
        if not is_valid_kyoto_coords(coords[1], coords[0]):
            continue
        if haversine_km(ward_coords[1], ward_coords[0], coords[1], coords[0]) <= POI_MATCH_MAX_KM:
            return coords
    return None


def _matches_with_corporate_prefix(full_name_normalized, core):
    """正規化済み正式名称が「法人名＋施設名」の形で core と一致するかを判定する。

    医療情報ネットの正式名称にはスペース無しで法人名を含むもの
    （例:「医療法人愛智会京都北野病院」→ normalize後「愛智会京都北野病院」）があり、
    core_name の完全一致では拾えない。単純な後方一致だと「三幸会第二北山病院」が
    「北山病院」に誤マッチするため、除去される接頭辞が法人名らしい
    （会・機構・協会等で終わる）場合のみ一致とみなす。
    例: 「愛智会京都北野病院」vs「京都北野病院」→ 接頭辞「愛智会」→ 一致
        「三幸会第二北山病院」vs「北山病院」→ 接頭辞「三幸会第二」→ 不一致
        「恵心会京都武田病院」vs「武田病院」→ 接頭辞「恵心会京都」→ 不一致
    """
    if not full_name_normalized.endswith(core):
        return False
    prefix = full_name_normalized[: len(full_name_normalized) - len(core)]
    if not prefix:
        return True  # 完全一致（通常は前段のパスで処理済み）
    return prefix.endswith(CORPORATE_SUFFIXES)


def _build_name_indexes(items, name_keys):
    """名寄せ用に (normalize_name索引, core_name索引) の2つを作る。同名はリストで保持。"""
    full_index = {}
    core_index = {}
    for item in items:
        for key in name_keys:
            label = item.get(key) or ""
            if not label:
                continue
            full_index.setdefault(normalize_name(label), []).append(item)
            core_index.setdefault(core_name(label), []).append(item)
    return full_index, core_index


def _find_unique(full_index, core_index, hosp):
    """病院1件を3段階で検索する。

    1) normalize_name の完全一致
    2) core_name（スペース区切り末尾＝施設名部分）の完全一致
    3) 法人名らしい接頭辞を除くと core_name に一致（_matches_with_corporate_prefix）
    いずれも、誤マッチ防止のため ward（区名）が住所に含まれることを必須条件にし、
    候補がちょうど1件のときだけ採用する（複数一致は曖昧として不採用）。
    """
    core = core_name(hosp["name"])
    for index, key in (
        (full_index, normalize_name(hosp["name"])),
        (core_index, core),
    ):
        candidates = {
            id(item): item
            for item in index.get(key, [])
            if hosp["ward"] in item["address"]
        }
        if len(candidates) == 1:
            return next(iter(candidates.values()))

    candidates = {
        id(item): item
        for norm_label, items in full_index.items()
        if _matches_with_corporate_prefix(norm_label, core)
        for item in items
        if hosp["ward"] in item["address"]
    }
    if len(candidates) == 1:
        return next(iter(candidates.values()))
    return None


def merge_monowasure_hospitals(records, hospitals, facilities):
    """あんしんナビ「もの忘れ外来一覧」（京都市内の病院）を統合する。

    1) 既存レコード（センター統合済みの認知症対応施設）に名寄せ
       → monowasure=True / level="専門" に昇格、telが空なら補完、source追記
    2) 一致しない場合は医療情報ネット施設票（スコープ内全施設）から名称＋区名で検索し、
       住所・座標・URLを取得して新規追加
    3) それでも見つからなければ国土地理院の施設名POIジオコーディング（geocode_poi）で
       座標化して追加
    4) 座標が確実に特定できない場合は追加せず「特定できなかった施設」として報告する

    戻り値: (matched, from_facility, geocoded, unresolved) 施設名のリスト4つ
    """
    rec_full, rec_core = _build_name_indexes(records, ("name",))
    fac_full, fac_core = _build_name_indexes(list(facilities.values()), ("name", "abbr"))

    matched, from_facility, geocoded, unresolved = [], [], [], []
    ward_coords_cache = {}

    def register(new_rec):
        """新規レコードを records と索引に追加する（後続行からの重複追加を防ぐ）。"""
        records.append(new_rec)
        rec_full.setdefault(normalize_name(new_rec["name"]), []).append(new_rec)
        rec_core.setdefault(core_name(new_rec["name"]), []).append(new_rec)

    for hosp in hospitals:
        # 1) 既存レコードへの名寄せ（府立医大・北山病院など既に「専門」の施設もここで
        #    吸収されるため重複追加は起きない）
        rec = _find_unique(rec_full, rec_core, hosp)
        if rec is not None:
            rec["monowasure"] = True
            rec["level"] = "専門"
            if not rec["tel"]:
                rec["tel"] = hosp["tel"]
            if hosp["source"] not in rec["source"]:
                rec["source"] = (
                    rec["source"] + " / " + hosp["source"] if rec["source"] else hosp["source"]
                )
            matched.append(hosp["name"])
            continue

        # 2) 医療情報ネット施設票（全施設）から名称＋区名で補完
        fac = _find_unique(fac_full, fac_core, hosp)
        if fac is not None:
            register({
                "id": None,
                "name": hosp["name"],
                "address": fac["address"],
                "tel": hosp["tel"] or fac["url"],
                "lat": fac["lat"],
                "lon": fac["lon"],
                "level": "専門",
                "shindan": False,
                "monowasure": True,
                "zaitaku": False,
                "supportdoc": False,
                "area": "",
                "source": hosp["source"],
            })
            from_facility.append(hosp["name"])
            continue

        # 3) 国土地理院の施設名POIジオコーディングで座標化
        simple_name = re.split(r"[\s　]+", hosp["name"].strip())[-1]
        coords = geocode_poi(simple_name, hosp["ward"], ward_coords_cache)
        if coords is not None:
            register({
                "id": None,
                "name": hosp["name"],
                "address": "京都府" + hosp["ward"],  # 詳細住所は元データ未収載のため区まで
                "tel": hosp["tel"],
                "lat": coords[1],
                "lon": coords[0],
                "level": "専門",
                "shindan": False,
                "monowasure": True,
                "zaitaku": False,
                "supportdoc": False,
                "area": "",
                "source": hosp["source"],
            })
            geocoded.append(hosp["name"])
            continue

        # 4) 特定できず（座標なしのレコードは追加しない）
        unresolved.append(hosp["name"])

    return matched, from_facility, geocoded, unresolved


def update_data_version(index_html_path=INDEX_HTML):
    """index.html の DATA_VERSION（clinics.geojsonのキャッシュバスター）を今日の日付に更新する。

    期待パターン（const DATA_VERSION = "YYYYMMDD";）がちょうど1箇所見つかった場合のみ
    書き換える。見つからない・複数ある場合は既存HTMLを壊さないよう何も変更せず、
    手動更新のリマインドだけを表示する。
    """
    today = time.strftime("%Y%m%d")
    reminder = f"  → index.html の DATA_VERSION を今日の日付（{today}）に手動で更新してください。"
    try:
        html = index_html_path.read_text(encoding="utf-8")
    except OSError as exc:
        print(f"[WARN] {index_html_path.name} を読み込めませんでした（{exc}）。")
        print(reminder)
        return

    matches = DATA_VERSION_RE.findall(html)
    if len(matches) != 1:
        print(f"[WARN] {index_html_path.name} 内で DATA_VERSION 定義を特定できませんでした（{len(matches)} 箇所）。")
        print(reminder)
        return

    current = matches[0][1]
    if current == today:
        print(f"index.html の DATA_VERSION は既に今日の日付（{today}）です。更新不要。")
        return

    new_html = DATA_VERSION_RE.sub(lambda m: m.group(1) + today + m.group(3), html)
    index_html_path.write_text(new_html, encoding="utf-8")
    print(f"index.html の DATA_VERSION を {current} → {today} に更新しました（ブラウザキャッシュ対策）。")


def main(scope):
    scope_label = "京都市内" if scope == "city" else "京都府全域"
    print(f"施設票を読み込み中（{scope_label}のみ抽出）...")
    hospital_facilities = load_kyoto_facilities(HOSPITAL_FACILITY_CSV, scope)
    clinic_facilities = load_kyoto_facilities(CLINIC_FACILITY_CSV, scope)
    print(f"  病院（{scope_label}）: {len(hospital_facilities)} 件")
    print(f"  診療所（{scope_label}）: {len(clinic_facilities)} 件")

    print("診療科目名を読み込み中...")
    hospital_depts = load_dept_names(HOSPITAL_HOURS_CSV, hospital_facilities.keys())
    clinic_depts = load_dept_names(CLINIC_HOURS_CSV, clinic_facilities.keys())

    print("施設票と診療科目名を結合し、認知症/もの忘れ関連施設を抽出中...")
    records = build_dementia_features(hospital_facilities, hospital_depts)
    records += build_dementia_features(clinic_facilities, clinic_depts)
    print(f"  {scope_label}の認知症対応施設: {len(records)} 件")

    print(f"京都府認知症疾患医療センターを統合中（{scope_label}のセンターのみ）...")
    centers = load_dementia_centers(DEMENTIA_CENTERS_CSV, scope)
    print(f"  対象センター: {len(centers)} 件")
    matched_count, added_count = merge_dementia_centers(records, centers)
    print(f"  既存施設と名寄せして上書き: {matched_count} 件")
    print(f"  新規追加: {added_count} 件")

    print("あんしんナビ「もの忘れ外来一覧」（京都市内の病院）を統合中...")
    monowasure_hospitals = load_monowasure_hospitals(MONOWASURE_HOSPITALS_CSV)
    all_facilities = {**hospital_facilities, **clinic_facilities}
    mono_matched, mono_from_facility, mono_geocoded, mono_unresolved = (
        merge_monowasure_hospitals(records, monowasure_hospitals, all_facilities)
    )
    print(f"  リスト掲載: {len(monowasure_hospitals)} 件")
    print(f"  名寄せで既存施設にマッチ（専門へ昇格）: {len(mono_matched)} 件")
    print(f"  医療情報ネット施設票から補完して新規追加: {len(mono_from_facility)} 件")
    print(f"  ジオコーディングで座標化して新規追加: {len(mono_geocoded)} 件")
    if mono_unresolved:
        print(f"  [WARN] 特定できなかった施設（未追加）: {len(mono_unresolved)} 件")
        for name in mono_unresolved:
            print(f"    - {name}")

    print("緯度経度が無効な施設をジオコーディング中...")
    geocoded_count = 0
    failed_count = 0
    for rec in records:
        if is_valid_kyoto_coords(rec["lat"], rec["lon"]):
            continue
        coords = geocode_gsi(rec["address"])
        time.sleep(GEOCODE_SLEEP_SEC)
        if coords is None:
            failed_count += 1
            continue
        rec["lon"], rec["lat"] = coords
        geocoded_count += 1
    print(f"  ジオコーディング成功: {geocoded_count} 件 / 失敗: {failed_count} 件")

    features = []
    skipped_no_coords = 0
    for rec in records:
        if not is_valid_kyoto_coords(rec["lat"], rec["lon"]):
            skipped_no_coords += 1
            continue
        features.append({
            "type": "Feature",
            "geometry": {
                "type": "Point",
                "coordinates": [float(rec["lon"]), float(rec["lat"])],
            },
            "properties": {
                "name": rec["name"],
                "address": rec["address"],
                "tel": rec["tel"],
                "area": rec["area"],
                "level": rec["level"],
                "shindan": rec["shindan"],
                "monowasure": rec["monowasure"],
                "zaitaku": rec["zaitaku"],
                "supportdoc": rec["supportdoc"],
                "source": rec["source"],
            },
        })

    geojson = {"type": "FeatureCollection", "features": features}
    with OUTPUT_GEOJSON.open("w", encoding="utf-8") as fh:
        json.dump(geojson, fh, ensure_ascii=False, indent=2)

    print()
    print("=== 結果サマリー ===")
    print(f"抽出スコープ: {scope_label}（--scope {scope}）")
    print(f"{scope_label}の認知症/もの忘れ関連施設（座標確定分）: {len(features)} 件")
    if skipped_no_coords:
        print(f"  ※座標が確定できず出力から除外: {skipped_no_coords} 件")
    print(f"  level=専門（診療科目名/施設名に明記）: {sum(f['properties']['level'] == '専門' for f in features)} 件")
    print(f"  level=関連（精神科/神経内科/脳神経内科/老年科などで一致）: {sum(f['properties']['level'] == '関連' for f in features)} 件")
    print(f"  shindan（鑑別診断）    : {sum(f['properties']['shindan'] for f in features)} 件")
    print(f"  monowasure（もの忘れ外来）: {sum(f['properties']['monowasure'] for f in features)} 件")
    print(f"  zaitaku（訪問診療・在宅） : {sum(f['properties']['zaitaku'] for f in features)} 件")
    print(f"  supportdoc（認知症サポート医）: {sum(f['properties']['supportdoc'] for f in features)} 件")
    print(f"京都府認知症疾患医療センター: 名寄せ上書き {matched_count} 件 / 新規追加 {added_count} 件")
    print(
        f"あんしんナビ もの忘れ外来一覧({len(monowasure_hospitals)}件): "
        f"名寄せ {len(mono_matched)} 件 / 施設票補完 {len(mono_from_facility)} 件 / "
        f"ジオコーディング {len(mono_geocoded)} 件 / 未特定 {len(mono_unresolved)} 件"
    )
    print(f"出力先: {OUTPUT_GEOJSON}")
    print()
    update_data_version()


if __name__ == "__main__":
    parser = argparse.ArgumentParser(
        description="医療情報ネットCSVから認知症対応医療機関のclinics.geojsonを生成する"
    )
    parser.add_argument(
        "--scope",
        choices=["city", "pref"],
        default="city",
        help="抽出範囲: city=京都市内のみ（デフォルト） / pref=京都府全域",
    )
    args = parser.parse_args()
    main(args.scope)
