const USER_ID = "test_user";

const BACKEND_NGROK_DOMAIN = "cringing-niece-playpen.ngrok-free.dev";
const httpApiBase = `https://${BACKEND_NGROK_DOMAIN}`;

async function fetchBalance() {
    try {
        const res = await fetch(`${httpApiBase}/api/balance/${USER_ID}`, {
            headers: {
                "ngrok-skip-browser-warning": "true"
            }
        });
        const data = await res.json();
        document.getElementById("current-balance").innerText = data.balance.toLocaleString();
    } catch (e) {
        console.error("Failed to fetch balance", e);
    }
}

document.querySelectorAll('.buy-btn').forEach(btn => {
    btn.addEventListener('click', async (e) => {
        const amount = parseInt(e.target.getAttribute('data-amount'));
        e.target.innerText = "Processing...";
        e.target.disabled = true;
        
        try {
            const res = await fetch(`${httpApiBase}/api/refill-tokens`, {
                method: 'POST',
                headers: { 
                    'Content-Type': 'application/json',
                    'ngrok-skip-browser-warning': 'true'
                },
                body: JSON.stringify({ user_id: USER_ID, amount: amount })
            });
            const data = await res.json();
            document.getElementById("current-balance").innerText = data.new_balance.toLocaleString();
            
            // Success animation
            e.target.innerText = "Purchased!";
            e.target.style.backgroundColor = "var(--success)";
            setTimeout(() => {
                e.target.innerText = "Buy Now";
                e.target.style.backgroundColor = "var(--primary)";
                e.target.disabled = false;
            }, 2000);
            
        } catch (error) {
            console.error("Purchase failed", error);
            e.target.innerText = "Failed";
            e.target.style.backgroundColor = "var(--danger)";
        }
    });
});

// Load initial balance
fetchBalance();
