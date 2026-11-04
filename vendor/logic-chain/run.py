from app.settings import load_env
load_env()
import sys
if __name__=='__main__':
    if sys.argv[1:2]==['verify']:
        from app.verify import main as verify
        raise SystemExit(verify(sys.argv[2:]))
    from app.server import main
    main()
