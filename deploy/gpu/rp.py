"""Minimal RunPod GraphQL helper. RUNPOD_API_KEY from env (never printed).
  rp.py balance | list | status <id> | terminate <id> | terminate-all
  rp.py create <name> <gpuTypeId> <COMMUNITY|SECURE> <dockerArgs>
Every created pod id is appended to pods.txt next to this file.
KEYENV=1 passes VLLM_API_KEY from VLLM_KEY_FILE (default ./vllm.key)."""
import json, os, sys, urllib.request

HERE = os.path.dirname(os.path.abspath(__file__))
KEY = os.environ["RUNPOD_API_KEY"]


def gql(query, variables=None):
    req = urllib.request.Request("https://api.runpod.io/graphql", method="POST",
                                 data=json.dumps({"query": query, "variables": variables or {}}).encode(),
                                 headers={"content-type": "application/json", "authorization": f"Bearer {KEY}", "user-agent": "curl/8.4.0"})
    try:
        return json.load(urllib.request.urlopen(req, timeout=60))
    except urllib.error.HTTPError as e:
        return {"errors": [{"message": f"HTTP {e.code}: {e.read()[:300]!r}"}]}


cmd = sys.argv[1]
if cmd == "balance":
    print(json.dumps(gql("{ myself { clientBalance currentSpendPerHr } }")))
elif cmd == "list":
    print(json.dumps(gql("{ myself { pods { id name desiredStatus costPerHr lastStatusChange runtime { uptimeInSeconds } } } }")["data"]["myself"]["pods"], indent=1))
elif cmd == "status":
    print(json.dumps(gql('query($id:String!){ pod(input:{podId:$id}) { id name desiredStatus costPerHr lastStatusChange machine { gpuDisplayName location } runtime { uptimeInSeconds gpus { gpuUtilPercent memoryUtilPercent } container { cpuPercent memoryPercent } } } }', {"id": sys.argv[2]})))
elif cmd == "create":
    name, gpu, cloud, args = sys.argv[2:6]
    inp = {"cloudType": cloud, "gpuCount": int(os.environ.get("GPUS", "1")), "gpuTypeId": gpu, "name": name, "imageName": os.environ.get("IMAGE", "vllm/vllm-openai:v0.33.0"),
           "containerDiskInGb": int(os.environ.get("DISK", "120")), "volumeInGb": 0, "ports": os.environ.get("PORTS", "8000/http"), "dockerArgs": args,
           "minVcpuCount": int(os.environ.get("MINCPU", "2")), "minMemoryInGb": int(os.environ.get("MINMEM", "15")), "startSsh": False, "startJupyter": False, **({"allowedCudaVersions": os.environ["CUDAV"].split(",")} if os.environ.get("CUDAV") else {}),
           "env": [{"key": "VLLM_LOGGING_LEVEL", "value": "INFO"}] + ([{"key": "VLLM_API_KEY", "value": open(os.environ.get("VLLM_KEY_FILE", os.path.join(HERE, "vllm.key"))).read().strip()}] if os.environ.get("KEYENV") else []) + ([{"key": "CTL_TOKEN", "value": open(os.environ.get("VLLM_KEY_FILE", os.path.join(HERE, "vllm.key"))).read().strip()}, {"key": "CTL_SRC", "value": __import__("base64").b64encode(open(os.path.join(HERE, "ctl.py"), "rb").read()).decode()}] if os.environ.get("CTL") else []) + [{"key": kv.split("=",1)[0], "value": kv.split("=",1)[1]} for kv in os.environ.get("EXTRAENV","").split(",") if "=" in kv]}
    r = gql("mutation($input: PodFindAndDeployOnDemandInput!){ podFindAndDeployOnDemand(input:$input){ id costPerHr machine { gpuDisplayName location } } }", {"input": inp})
    p = (r.get("data") or {}).get("podFindAndDeployOnDemand")
    if p and p.get("id"):
        with open(os.path.join(HERE, "pods.txt"), "a") as f:
            f.write(p["id"] + "\n")
    print(json.dumps(r))
elif cmd == "terminate":
    print(json.dumps(gql('mutation($id:String!){ podTerminate(input:{podId:$id}) }', {"id": sys.argv[2]})))
elif cmd == "terminate-all":
    ids = set()
    if os.path.exists(os.path.join(HERE, "pods.txt")):
        ids |= {l.strip() for l in open(os.path.join(HERE, "pods.txt")) if l.strip()}
    ids |= {p["id"] for p in gql("{ myself { pods { id } } }")["data"]["myself"]["pods"]}
    for i in sorted(ids):
        print(i, json.dumps(gql('mutation($id:String!){ podTerminate(input:{podId:$id}) }', {"id": i})))
    print("remaining:", json.dumps(gql("{ myself { pods { id desiredStatus } } }")["data"]["myself"]["pods"]))
