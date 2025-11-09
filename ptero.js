// ptero.js
const axios = require('axios');

class Ptero {
  constructor({ url, applicationKey }) {
    if (!url || !applicationKey) throw new Error('Pterodactyl config missing');
    this.base = url.replace(/\/+$/, '') + '/api/application';
    this.client = axios.create({
      baseURL: this.base,
      headers: {
        'Authorization': `Bearer ${applicationKey}`,
        'Accept': 'application/json',
        'Content-Type': 'application/json'
      },
      timeout: 30000
    });
  }

  // Create a Pterodactyl user
  async createUser({ username, email, first_name = 'Kaesyr', last_name = 'User', password }) {
    const body = { username, email, first_name, last_name, password };
    const res = await this.client.post('/users', body);
    return res.data;
  }

  // Create a server. 'allocation' is a single allocation id
  async createServer({ name, user, nest, egg, docker_image, startup, memory, disk, cpu, allocation }) {
    const body = {
      name,
      user,
      nest,
      egg,
      docker_image,
      startup,
      environment: {},
      limits: {
        memory,
        swap: 0,
        disk,
        io: 500,
        cpu
      },
      feature_limits: {},
      allocation,
      allocations: [allocation]
    };
    const res = await this.client.post('/servers', body);
    return res.data;
  }

  // Get nodes in a location
  async getNodesForLocation(locationId) {
    const res = await this.client.get(`/locations/${locationId}/nodes`);
    return res.data; // usually { data: [...] }
  }

  // Get allocations for node
  async getAllocationsForNode(nodeId) {
    const res = await this.client.get(`/nodes/${nodeId}/allocations`);
    return res.data;
  }

  // Try to find one free allocation. Strategy:
  // - If DEFAULT_ALLOCATION_ID env var is set, prefer it (if free).
  // - Otherwise, if DEFAULT_NODE_ID is set, scan that node for unassigned allocation.
  // - Otherwise, iterate all nodes in given location and find first unassigned allocation.
  async findFreeAllocation(locationId, preferNodeId = null, preferAllocationId = null) {
    // 1) If preferAllocationId provided, check if it's free by querying node allocations (need the node)
    if (preferAllocationId) {
      // we must find which node owns this allocation via nodes list
      // fallthrough to scanning nodes and check for allocation id match
    }

    // get nodes in location
    const nodesResp = await this.client.get(`/locations/${locationId}/nodes`);
    const nodes = nodesResp.data?.data || [];

    // helper to scan a node's allocations
    const scanNode = async (node) => {
      const nodeId = node.attributes?.id || node.id || node.attributes?.identifier || node.attributes?.node_id || node.attributes?.uuid;
      if (!nodeId) return null;
      const allocResp = await this.client.get(`/nodes/${nodeId}/allocations`);
      const allocs = allocResp.data?.data || allocResp.data || [];
      // prefer unassigned allocations (attributes.assigned === false)
      for (const a of allocs) {
        const attr = a.attributes || a;
        // attr.assigned sometimes exists, sometimes not; also check attr.server_id / attr.assigned
        const assigned = typeof attr.assigned !== 'undefined' ? attr.assigned : !!attr.server_id; // server_id truthy means assigned
        const allocId = attr.id || attr.attributes?.id || attr.attributes?.allocation || attr.attributes?.allocation_id;
        if (!assigned) {
          return { allocationId: allocId, ip: attr.ip || attr.attributes?.ip, port: attr.port || attr.attributes?.port, nodeId };
        }
      }
      return null;
    };

    // 2) If a preferNodeId provided, attempt it first
    if (preferNodeId) {
      const node = nodes.find(n => {
        const nid = n.attributes?.id || n.id;
        return String(nid) === String(preferNodeId);
      });
      if (node) {
        const r = await scanNode(node);
        if (r) return r;
      }
    }

    // 3) Scan all nodes
    for (const node of nodes) {
      const r = await scanNode(node);
      if (r) return r;
    }

    throw new Error('No free allocations found');
  }

  // Extract IP/port from server creation response (try common shapes)
  extractIpPortFromServer(serverResp) {
    const candidate = serverResp?.data?.attributes || serverResp?.attributes || serverResp;
    // allocations might be under relationships.allocations.data[]
    const allocs = candidate?.relationships?.allocations?.data || candidate?.attributes?.allocation || candidate?.attributes?.allocations || candidate?.allocations;
    if (Array.isArray(allocs) && allocs.length > 0) {
      const main = allocs[0].attributes || allocs[0];
      return { ip: main.ip || main.attributes?.ip, port: main.port || main.attributes?.port };
    }
    // fallback: check candidate.attributes?.allocation
    try {
      const a = candidate?.attributes?.allocation;
      if (a) return { ip: a.ip || a.attributes?.ip, port: a.port || a.attributes?.port };
    } catch (e) {}
    return null;
  }
}

module.exports = Ptero;