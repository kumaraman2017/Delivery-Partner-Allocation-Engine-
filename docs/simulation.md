
# Phase-1

Here is the detailed, file-by-file blueprint for implementing your basic model (straight-line, fixed 40 km/h speed).  
By structuring your project exactly like this, you ensure that no code is wasted. When you are ready to transition to real road paths and traffic later, you will only need to modify one or two files instead of rewriting the whole system.

### **1\. Project Folder Structure**

First, organize your backend to separate database logic from the fast-paced simulation logic:

* src/models.js (Database definitions)  
* src/allocationEngine.js (The matchmaker)  
* src/simulation/activeTripsStore.js (In-memory RAM storage)  
* src/simulation/simulationEngine.js (The continuous heartbeat)  
* src/server.js (The API and WebSocket setup)

### **2\. File-by-File Implementation Plan**

#### **File A: src/models.js**

**Purpose:** Defines your MongoDB structures.

* **What to implement here:** \* Create the Mongoose schemas exactly as defined in your spec.  
  * **Rider Schema:** Needs fields for current latitude, longitude, availabilityStatus (ONLINE/OFFLINE), and status (IDLE, ACCEPTED, PICKED\_UP).  
  * **Order Schema:** Needs restaurantLat/Lng, customerLat/Lng, status (PENDING, ASSIGNED, PICKED\_UP, DELIVERED), and a progress tracker.  
  * *Transition Note:* This file will **not change at all** when you upgrade to advanced routing later.

#### **File B: src/simulation/activeTripsStore.js**

**Purpose:** Protects your database. If you write coordinates to MongoDB every 2 seconds, your database will crash. This file acts as a temporary "scratchpad" in your server's RAM.

* **What to implement here:**  
  * Create a simple JavaScript Map (dictionary).  
  * Write a function to **Add a Trip** (triggered when an order is assigned).  
  * Write a function to **Remove a Trip** (triggered when an order is delivered).  
  * Write a function to **Get All Active Trips** (used by the heartbeat to know who to move).

#### **File C: src/allocationEngine.js**

**Purpose:** Matches the rider and injects them into the simulation.

* **What to implement here:**  
  * Write logic that finds the best IDLE rider for a PENDING order (using your ETAR and H3 logic).  
  * Once a rider is chosen, update the database: Rider is ACCEPTED, Order is ASSIGNED.  
  * **The Crucial Setup Step:** Calculate the total straight-line distance (using a Haversine formula library like Turf.js) for **Leg 1** (Rider to Restaurant) and **Leg 2** (Restaurant to Customer).  
  * Inject a "Trip Object" into activeTripsStore.js. This object must contain: The Rider ID, Order ID, current coordinates, the total distance of Leg 1, and the total distance of Leg 2\.

#### **File D: src/simulation/simulationEngine.js**

**Purpose:** The engine room. This is where the fixed 40 km/h math happens.

* **What to implement here:**  
  * Set up a setInterval timer that triggers every **2 seconds** (The Heartbeat).  
  * Inside the heartbeat, fetch all active trips from the activeTripsStore.  
  * **The Math:** For every active trip, define a fixed distance budget of **22.22 meters** (which equals 40 km/h over 2 seconds).  
  * **The Movement:** Check how many meters the rider has traveled on their current Leg. Add 22.22 meters to it.  
  * **The Interpolation:** Use a "Lerp" (Linear Interpolation) math function. If a leg is 1000 meters total, and the rider has traveled 500 meters, the math puts their new GPS coordinate exactly at the 50% mark on the straight line between the start and end points. Update the trip object in memory with this new coordinate.  
  * **The Snapping Logic:** If the remaining distance on a leg is less than 22.22 meters, force the rider's coordinate to the destination. If it's the restaurant, switch them to Leg 2 and update MongoDB to PICKED\_UP. If it's the customer, update MongoDB to DELIVERED and remove the trip from memory.  
  * **The Broadcast:** At the very end of the 2-second heartbeat, gather all the freshly calculated coordinates and use socket.io to emit one single array to the frontend.

#### **File E: src/server.js**

**Purpose:** The front door of your application.

* **What to implement here:**  
  * Initialize your Express server and your Socket.IO server.  
  * Connect to MongoDB.  
  * Call the function to start the heartbeat from simulationEngine.js.  
  * Set up the REST API endpoints outlined in your merged.md file (e.g., POST /orders, POST /allocate-order, GET /riders, etc.). When POST /allocate-order is hit, it simply calls the function in allocationEngine.js.

### **How the Flow Works in Action (The Mental Model)**

1. **Trigger:** An admin hits the POST /orders endpoint on server.js.  
2. **Match:** allocationEngine.js finds a rider. It calculates the straight-line distance to the restaurant (e.g., 800 meters).  
3. **Store:** It saves a new trip into activeTripsStore.js with 0 meters traveled.  
4. **Tick 1:** The 2-second heartbeat in simulationEngine.js ticks. It sees the new trip. It moves the rider 22.22 meters along the straight line. It broadcasts the new GPS point via WebSocket.  
5. **Tick N:** The heartbeat continues every 2 seconds until the accumulated distance reaches 800 meters. The engine snaps the rider to the restaurant, updates the database to PICKED\_UP, and loads the distance for the Customer drop-off.

### **Why this guarantees a smooth transition later:**

When you want to add Real Roads and Traffic, **Files A, B, C, and E do not change**.  
You will only open File D (simulationEngine.js), change the distance budget to check H3 traffic zones, and change the straight-line Lerp math to loop over a Mapbox road array instead. Everything else remains perfectly intact\!

---

# Phase-2

Here is the detailed implementation blueprint for **Phase 2: The "Street-Snapped" Fleet**.  
In Phase 1, your simulation loop (simulation.js) moved the rider in a straight line between two points. In Phase 2, you will integrate the **Mapbox Directions API** to snap that movement to actual road networks.  
Here is exactly how to implement this transition and where to apply the changes in your architecture.




### **The Core Concept Shift: From "Line" to "Array"**

Instead of calculating a single straight line from the Rider to the Restaurant, your backend will now fetch a **Polyline** from Mapbox. A Polyline is simply a "connect-the-dots" array of hundreds of tiny GPS coordinates that follow the curves of the streets.  
Your 2-second heartbeat loop will still consume a distance budget (e.g., 22.22 meters for 40 km/h), but it will consume it by hopping from dot to dot along this array.

### **Step-by-Step Implementation Plan**

#### **1\. Setup & Environment**

* **Action:** Create an account on Mapbox, generate an API key (access token), and add it to your backend .env file as MAPBOX\_TOKEN.  
* **Dependencies:** Install axios on your Node.js backend to make HTTP requests to the Mapbox API, and @turf/turf (if not already installed) to easily calculate distances between the small road segments.

#### **2\. Create the Routing Service (New File)**

* **Where:** Create a new file, e.g., src/routingService.js.  
* **What to implement:** Create a function getRoadRoute(startCoords, endCoords).  
* **The Logic:**  
  * This function makes a GET request to the Mapbox Directions API using the driving profile.  
  * Mapbox will return a GeoJSON array of coordinates representing the road path.  
  * Calculate and store the distance between each consecutive node in this array.  
  * **Return:** The array of GPS nodes and the pre-calculated segment distances.

#### **3\. Update the Allocation Engine**

* **Where:** src/allocationEngine.js (where the rider is matched and the order is ASSIGNED).  
* **What to implement:** \* Right after your engine selects the winning rider based on ETAR, call your new getRoadRoute() function **twice**:  
  1\. **Leg 1:** Rider's current location $\\rightarrow$ Restaurant location.  
  2\. **Leg 2:** Restaurant location $\\rightarrow$ Customer location.  
  * Save these detailed road arrays into your in-memory activeTripsStore so the simulation loop can access them.

#### **4\. Upgrade the Simulation Heartbeat (The Toughest Part)**

* **Where:** src/simulation.js (the 2-second interval loop).  
* **What to implement:** You must upgrade the movement math. It is no longer a simple A-to-B interpolation.  
* **The Logic (Array Traversal):**  
  * For each active trip, maintain a currentSegmentIndex (which pair of dots the rider is currently driving between) and distanceTraveledOnSegment.  
  * Every 2 seconds, grant the rider their 22.22-meter budget.  
  * **Check the segment:** If the distance to the next dot in the array is *greater* than 22.22m, slide the rider forward on that segment.  
  * **The "Carry-Over" logic (Crucial):** If the next dot is only 5 meters away, the rider reaches the turn\! Move the rider to that dot, subtract 5m from the budget (17.22m remaining), increment the currentSegmentIndex by 1 to turn the corner, and apply the remaining 17.22m down the *next* street segment.  
  * Once the index reaches the end of the Leg 1 array, update MongoDB to PICKED\_UP and switch to the Leg 2 array.  
  * Broadcast the exact road-snapped coordinate via Socket.IO.

#### **5\. Upgrade the Frontend Maps (React)**

* **Where:** Your React components for the **Rider Map** and **Order Map**.  
* **What to implement:** \* **The Route Line:** In Phase 1, you drew a straight line. Now, when an order is opened, your frontend should also call the Mapbox API (or receive the array from your backend) to draw a \<Layer type="line"\> that explicitly follows the road curves.  
  * **The Marker:** You actually don't need to change the marker animation logic\! Because your backend is streaming perfectly road-snapped coordinates every 2 seconds, the React marker will naturally glide along the curves of the drawn street line.

### **Why this approach is safe**

By isolating the Mapbox API call to routingService.js and storing the arrays in RAM, you avoid hitting the Mapbox API on every single tick of the simulation. You only hit the API **once** when the order is assigned. The heartbeat loop then processes that stored data locally, keeping your backend fast, deterministic, and well within Mapbox's free tier limits.

---

# Phase-3

### **Core Concept Shift**

Instead of a fixed 22.22-meter budget per tick, your 2-second loop looks up the live speed of the road segment the rider is currently on:

$$\\text{Distance Budget for Tick} \= \\text{Mapbox Segment Speed (m/s)} \\times 2\\text{ seconds}$$  
Riders naturally slow down to a crawl on congested roads and speed up on highways.

### **Exact Files to Modify & What to Implement**

#### **1\. src/routingService.js (Backend)**

* **Change:** Modify the Mapbox API HTTP request.  
* **Implementation:** Change the URL routing profile to driving-traffic and add the parameter annotations=speed,congestion.  
* **Result:** The API will now return the coordinate path array *plus* a parallel array containing the exact real-time speed (in meters per second) for every single block.

#### **2\. src/simulation/activeTripsStore.js (Backend)**

* **Change:** Update your temporary RAM cache schema.  
* **Implementation:** Expand the active trip memory object to include a new field: segmentSpeeds array.  
* **Result:** This stores the dynamic traffic speed data fetched by your routing service so the loop can access it instantly.

#### **3\. src/simulation/simulationEngine.js (Backend Heartbeat Loop)**

* **Change:** Replace the hardcoded 22.22m speed with dynamic math.  
* **Implementation:** 1\. Look up the rider's currentSegmentIndex.  
  2\. Pull the live speed for that index from the stored segmentSpeeds array.  
  3\. Calculate the tick's budget: speed \* 2\.  
  4\. Move the rider along the path nodes using this dynamic budget.  
  5\. **Fallback Safety:** If Mapbox returns a traffic speed of 0 m/s (gridlock), force a fallback minimum speed of 3 m/s (\~10 km/h) so the rider never freezes on screen permanently.

#### **4\. Your Frontend Map File (React UI)**

* **Change:** Update the route rendering style.  
* **Implementation:** Receive the traffic metadata along with the coordinates. Use Mapbox Map layer data expressions (line-color) to automatically style the road path segments: **Green** for optimal speed, **Yellow** for moderate slowdowns, and **Red** for heavy traffic.  
* **Result:** The user sees a multi-colored route line, and the rider marker naturally slows down visually whenever it crosses a red section.