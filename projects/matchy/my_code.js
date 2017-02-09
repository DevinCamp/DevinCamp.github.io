var animal = {};
animal.species = "Tiger";
animal['name'] = "Leo";
animal.noises = [];


var noises = [];
noises = ["roar"];
noises.push("pur");
noises.unshift("growl");
noises[-1] = "pew";


animal['noises'] = noises;
noises[noises.length] = "yawn";

var animals = [];
animals.push(animal);


var duck ={ species: 'duck', name: 'Jerome', noises: ['quack', 'honk', 'sneeze', 'woosh'], };
animals.push(duck);

var dog = { species: 'Dog', name: 'Dutch', noises: ['woff', 'bark', 'growl'] };
animals.push(dog);

var cat = { species: 'Cat', name: 'Lulu', noises: ['Moew', 'hiss', 'purr', ]  };
animals.push(cat);


console.log();

var friends = [];
// I picked an array becuse
function getAnimals(animals){
    
    return animals[Math.floor(Math.random() * animals.length)];
}

friends.push(getAnimals(animals).name);
animal.friends = friends;


function search(name){
        for(let key in animals){
            if(animals[key]["name"] === name){
                return animals[key];
            } 
        }return null;
}

 function edit (name, object){
    for(let key in animals){
        if(animals[key].name === name){
            animals[key] = object
        }
    }
    
} 

function remove(name){
    for(let key in animals){
            if(animals[key].name === name){
                return animals.splice(key, 1);
                
            } 
        }
    
}
function create(object){
   for(var i = 0; i < animals.length; i++){
       if (object.name === animals[i].name){
        return null  ;
       }
   }
     if(object.name.length > 0 && object.species.length > 0 ){
          return animals.push(object); 
       }

    
    
}

