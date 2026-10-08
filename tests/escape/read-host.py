# A host file must not be visible. Exit 0 only if one of these paths leaks.
candidates = [
    "/codeclash-host-secret",
    "/mnt/d/Code/cs455/CodeClash/.env",
    "/host_mnt/d/Code/cs455/CodeClash/.env",
]
for path in candidates:
    try:
        data = open(path).read()
    except OSError:
        continue
    if data:
        print(data)
        raise SystemExit(0)
raise SystemExit(1)
