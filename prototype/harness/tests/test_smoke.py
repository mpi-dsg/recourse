def test_import() -> None:
    import recourse_harness

    assert recourse_harness.SCHEMA_VERSION == 1
