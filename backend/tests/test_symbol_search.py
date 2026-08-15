"""Symbol search — offline tests over the local dictionary and merge logic."""

from app.services import symbol_search as ss


def test_chinese_name_substring():
    results = ss.search_local("茅台")
    assert results and results[0]["symbol"] == "600519.SS"
    assert results[0]["name"] == "贵州茅台"
    assert results[0]["exchange"] == "上交所"


def test_pinyin_initials():
    assert ss.search_local("gzmt")[0]["symbol"] == "600519.SS"
    assert ss.search_local("ndsd")[0]["symbol"] == "300750.SZ"


def test_code_prefix_and_exact():
    assert ss.search_local("600519")[0]["symbol"] == "600519.SS"
    prefixed = ss.search_local("6005")
    assert any(r["symbol"] == "600519.SS" for r in prefixed)


def test_us_chinese_alias():
    assert ss.search_local("苹果")[0]["symbol"] == "AAPL"
    assert ss.search_local("比特币")[0]["symbol"] == "BTC-USD"


def test_exact_symbol_ranks_first():
    # "000001" is both an index code (.SS) and 平安银行 (.SZ) — exact code
    # matches must precede substring matches, both must appear.
    symbols = [r["symbol"] for r in ss.search_local("000001")]
    assert "000001.SS" in symbols and "000001.SZ" in symbols


def test_cjk_detection_skips_remote():
    assert ss.has_cjk("茅台") and not ss.has_cjk("AAPL 600519")


def test_yahoo_normalizer_drops_junk_and_flattens():
    quotes = [
        {"symbol": "AAPL", "shortname": "Apple Inc.", "exchDisp": "NASDAQ", "quoteType": "EQUITY"},
        {"symbol": "AAPL240119C00050000", "quoteType": "OPTION"},
        {"quoteType": "EQUITY"},  # no symbol → dropped
        {"symbol": "BTC-USD", "longname": "Bitcoin USD", "quoteType": "CRYPTOCURRENCY"},
    ]
    out = ss.normalize_yahoo_quotes(quotes)
    assert [r["symbol"] for r in out] == ["AAPL", "BTC-USD"]
    assert out[0]["name"] == "Apple Inc."


def test_merge_dedupes_preferring_local():
    local = [{"symbol": "AAPL", "name": "苹果", "exchange": "US", "source": "local"}]
    remote = [
        {"symbol": "AAPL", "name": "Apple Inc.", "exchange": "NASDAQ", "source": "yahoo"},
        {"symbol": "APLE", "name": "Apple Hospitality", "exchange": "NYSE", "source": "yahoo"},
    ]
    merged = ss.merge_results(local, remote, limit=8)
    assert [r["symbol"] for r in merged] == ["AAPL", "APLE"]
    assert merged[0]["source"] == "local"


def test_dictionary_symbols_are_unique():
    symbols = [s for s, _, _ in [*ss.CN_STOCKS, *ss.US_ALIASES]]
    assert len(symbols) == len(set(symbols))
